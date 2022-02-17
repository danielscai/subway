import { formatUnits } from "@ethersproject/units";
import { ethers } from "ethers";
import { CONTRACTS, wssProvider, searcherWallet } from "./src/constants.js";
import {
  logDebug,
  logError,
  logFatal,
  logInfo,
  logSuccess,
  logTrace,
} from "./src/logging.js";
import { calcSandwichOptimalIn, calcSandwichState } from "./src/numeric.js";
import { parseUniv2RouterTx } from "./src/parse.js";
import {
  callBundleFlashbots,
  getRawTransaction,
  sanityCheckSimulationResponse,
  sendBundleFlashbots,
} from "./src/relayer.js";
import {
  getUniv2ExactWethTokenMinRecv,
  getUniv2PairAddress,
  getUniv2Reserve,
} from "./src/univ2.js";
import { calcNextBlockBaseFee, match, stringifyBN } from "./src/utils.js";

// Note: You'll probably want to break this function up
//       handling everything in here so you can follow along easily
const sandwichUniswapV2RouterTx = async (txHash) => {
  const strLogPrefix = `txhash=${txHash}`;

  // Bot not broken right
  // logTrace(strLogPrefix, "received");

  // Get tx data
  // 1. 检查tx 仍然有效。 
  const [tx, txRecp] = await Promise.all([
    wssProvider.getTransaction(txHash),
    wssProvider.getTransactionReceipt(txHash),
  ]);

  // Make sure transaction hasn't been mined
  if (txRecp !== null) {
    // console.log("tx has been minded");
    return;
  }

  // Sometimes tx is null for some reason
  if (tx === null) {
    // console.log("tx is null ");
    return;
  }

  // We're not a generalized version
  // So we're just gonna listen to specific addresses
  // and decode the data from there
  // 只监听了 uniswapv2router 的消息。 
  if (!match(tx.to, CONTRACTS.UNIV2_ROUTER)) {
    return;
  }
  // 如果是和uniswap router 交互的，则在这里打印一下。提示看到这个tx
  // 我自己的交易，竟然没有被捕获到。原因是国内网络不行， 换到国外网络就好了。 
  console.log("match to uniswap v2 router ",txHash);
  

  // Decode transaction data
  // i.e. is this swapExactETHForToken?
  // You'll have to decode all the other possibilities :P
  // 找到匹配的方法。 
  const routerDataDecoded = parseUniv2RouterTx(tx.data);

  // Basically means its not swapExactETHForToken and you need to add
  // other possibilities
  // 找不到的话，就返回了。 方法名不匹配。 
  if (routerDataDecoded === null) {
    return;
  }
  logTrace(txHash, "match swapExactETH for token");

  const { path, amountOutMin, deadline } = routerDataDecoded;

  // If tx deadline has passed, just ignore it
  // As we cannot sandwich it
  // deadline 检查，没什么花头。 
  if (new Date().getTime() / 1000 > deadline) {
    console.log("exceeded deadline");
    return;
  }

  // logTrace(txHash, "not exceeded received");

  // Get the min recv for token directly after WETH
  const userMinRecv = await getUniv2ExactWethTokenMinRecv(amountOutMin, path);
  const userAmountIn = tx.value; // User is sending exact ETH (not WETH)

  logTrace(
    strLogPrefix,
    "potentially sandwichable swapExactETHForTokens tx found",
    JSON.stringify(
      stringifyBN({
        userAmountIn,
        userMinRecv,
        path,
      })
    )
  );

  // Note: Since this is swapExactETHForTokens, the path will always be like so
  // Get the optimal in amount
  const [weth, token] = path;
  const pairToSandwich = getUniv2PairAddress(weth, token);
  const [reserveWeth, reserveToken] = await getUniv2Reserve(
    pairToSandwich,
    weth,
    token
  );

  // 计算是否有足够的利润， 
  // userAmountIn 是用户输入的金额，也就是eth的数量
  // userMinRecv 是计算出来的最小值，通过传入用户能接受的最小值，然后再算出一个最小值。差异是什么？
  const optimalWethIn = calcSandwichOptimalIn(
    userAmountIn,
    userMinRecv,
    reserveWeth,
    reserveToken
  );

  // Lmeow, nothing to sandwich!
  // 最佳输入值小于0， 怎么会小于零呢？ 二分查找的范围是0-100， 怎么也不可能是0啊。 
  if (optimalWethIn.lte(ethers.constants.Zero)) {
    return;
  }

  // Contains 3 states:
  // 1: Frontrun state
  // 2: Victim state
  // 3: Backrun state
  const sandwichStates = calcSandwichState(
    optimalWethIn,
    userAmountIn,
    userMinRecv,
    reserveWeth,
    reserveToken
  );

  // Sanity check failed
  if (sandwichStates === null) {
    logDebug(
      strLogPrefix,
      "sandwich sanity check failed",
      JSON.stringify(
        stringifyBN({
          optimalWethIn,
          reserveToken,
          reserveWeth,
          userAmountIn,
          userMinRecv,
        })
      )
    );
    return;
  }

  // Cool profitable sandwich :)
  // But will it be post gas?
  // 这里找到了可以三明治攻击的tx， 然后打印出来。 
  // 刚运行了很久，并没有找到这个数据打印出来。 
  logInfo(
    strLogPrefix,
    "sandwichable target found",
    JSON.stringify(stringifyBN(sandwichStates))
  );

  // Get block data to compute bribes etc
  // as bribes calculation has correlation with gasUsed
  // 计算gas 值。
  const block = await wssProvider.getBlock();
  const targetBlockNumber = block.number + 1;
  const nextBaseFee = calcNextBlockBaseFee(block);
  const nonce = await wssProvider.getTransactionCount(searcherWallet.address);

  // Craft our payload
  const frontslicePayload = ethers.utils.solidityPack(
    ["address", "address", "uint128", "uint128", "uint8"],
    [
      token,
      pairToSandwich,
      optimalWethIn,
      sandwichStates.frontrun.amountOut,
      ethers.BigNumber.from(token).lt(ethers.BigNumber.from(weth)) ? 0 : 1,
    ]
  );
  const frontsliceTx = {
    to: CONTRACTS.SANDWICH,
    from: searcherWallet.address,
    data: frontslicePayload,
    chainId: 1,
    maxPriorityFeePerGas: 0,
    maxFeePerGas: nextBaseFee,
    gasLimit: 250000,
    nonce,
    type: 2,
  };
  const frontsliceTxSigned = await searcherWallet.signTransaction(frontsliceTx);

  const middleTx = getRawTransaction(tx);

  const backslicePayload = ethers.utils.solidityPack(
    ["address", "address", "uint128", "uint128", "uint8"],
    [
      weth,
      pairToSandwich,
      sandwichStates.frontrun.amountOut,
      sandwichStates.backrun.amountOut,
      ethers.BigNumber.from(weth).lt(ethers.BigNumber.from(token)) ? 0 : 1,
    ]
  );
  const backsliceTx = {
    to: CONTRACTS.SANDWICH,
    from: searcherWallet.address,
    data: backslicePayload,
    chainId: 1,
    maxPriorityFeePerGas: 0,
    maxFeePerGas: nextBaseFee,
    gasLimit: 250000,
    nonce: nonce + 1,
    type: 2,
  };
  const backsliceTxSigned = await searcherWallet.signTransaction(backsliceTx);

  // Simulate tx to get the gas used
  // flashbot 竟然可以接受一个非自己签名的tx， 这他会怎么处理呢？ 
  // 三个tx 的bundle 三个签名的人还不一样，也能放在一起当做一个buddle 执行， 
  // 这大大增加了三明治攻击的成功率，如果失败，也不损失什么，这实在是太好了。 
  const signedTxs = [frontsliceTxSigned, middleTx, backsliceTxSigned];
  const simulatedResp = await callBundleFlashbots(signedTxs, targetBlockNumber);

  // Try and check all the errors
  try {
    sanityCheckSimulationResponse(simulatedResp);
  } catch (e) {
    logError(
      strLogPrefix,
      "error while simulating",
      JSON.stringify(
        stringifyBN({
          error: e,
          block,
          targetBlockNumber,
          nextBaseFee,
          nonce,
          sandwichStates,
          frontsliceTx,
          backsliceTx,
        })
      )
    );

    return;
  }

  // Extract gas
  const frontsliceGas = ethers.BigNumber.from(simulatedResp.results[0].gasUsed);
  const backsliceGas = ethers.BigNumber.from(simulatedResp.results[2].gasUsed);

  // Bribe 99.99% :P
  const bribeAmount = sandwichStates.revenue.sub(
    frontsliceGas.mul(nextBaseFee)
  );
  const maxPriorityFeePerGas = bribeAmount
    .mul(9999)
    .div(10000)
    .div(backsliceGas);

  // Note: you probably want some circuit breakers here so you don't lose money
  // if you fudged shit up

  // If 99.99% bribe isn't enough to cover base fee, its not worth it
  if (maxPriorityFeePerGas.lt(nextBaseFee)) {
    logTrace(
      strLogPrefix,
      `maxPriorityFee (${formatUnits(
        maxPriorityFeePerGas,
        9
      )}) gwei < nextBaseFee (${formatUnits(nextBaseFee, 9)}) gwei`
    );
    return;
  }

  // Okay, update backslice tx
  const backsliceTxSignedWithBribe = await searcherWallet.signTransaction({
    ...backsliceTx,
    maxPriorityFeePerGas,
  });

  // Fire the bundles
  const bundleResp = await sendBundleFlashbots(
    [frontsliceTxSigned, middleTx, backsliceTxSignedWithBribe],
    targetBlockNumber
  );
  logSuccess(
    strLogPrefix,
    "Bundle submitted!",
    JSON.stringify(
      block,
      targetBlockNumber,
      nextBaseFee,
      nonce,
      sandwichStates,
      frontsliceTx,
      maxPriorityFeePerGas,
      bundleResp
    )
  );
};

const main = async () => {
  logInfo(
    "============================================================================"
  );
  logInfo(
    "          _                       _         _   \r\n  ____  _| |____ __ ____ _ _  _  | |__  ___| |_ \r\n (_-< || | '_ \\ V  V / _` | || | | '_ \\/ _ \\  _|\r\n /__/\\_,_|_.__/\\_/\\_/\\__,_|\\_, | |_.__/\\___/\\__|\r\n | |__ _  _  | (_) |__  ___|__/__ __            \r\n | '_ \\ || | | | | '_ \\/ -_) V / '  \\           \r\n |_.__/\\_, | |_|_|_.__/\\___|\\_/|_|_|_|          \r\n       |__/                                     \n"
  );
  logInfo("github: https://github.com/libevm");
  logInfo("twitter: https://twitter.com/libevm");
  logInfo(
    "============================================================================\n"
  );
  logInfo(`Searcher Wallet: ${searcherWallet.address}`);
  logInfo(`Node URL: ${wssProvider.connection.url}\n`);
  logInfo(
    "============================================================================\n"
  );

  // Add timestamp to all subsequent console.logs
  // One little two little three little dependency injections....
  const origLog = console.log;
  console.log = function (obj, ...placeholders) {
    if (typeof obj === "string")
      placeholders.unshift("[" + new Date().toISOString() + "] " + obj);
    else {
      // This handles console.log( object )
      placeholders.unshift(obj);
      placeholders.unshift("[" + new Date().toISOString() + "] %j");
    }

    origLog.apply(this, placeholders);
  };

  logInfo("Listening to mempool...\n");

  // Listen to the mempool on local node
  wssProvider.on("pending", (txHash) =>
    sandwichUniswapV2RouterTx(txHash).catch((e) => {
      logFatal(`txhash=${txHash} error ${JSON.stringify(e)}`);
    })
  );
};

main();
