import { ethers } from "ethers";
import { uniswapV2Pair } from "./constants.js";
import { match } from "./utils.js";

/* 
  Sorts tokens
*/
export const sortTokens = (tokenA, tokenB) => {
  if (ethers.BigNumber.from(tokenA).lt(ethers.BigNumber.from(tokenB))) {
    return [tokenA, tokenB];
  }
  return [tokenB, tokenA];
};

/*
  Computes pair addresses off-chain
*/
export const getUniv2PairAddress = (tokenA, tokenB) => {
  const [token0, token1] = sortTokens(tokenA, tokenB);

  const salt = ethers.utils.keccak256(token0 + token1.replace("0x", ""));
  const address = ethers.utils.getCreate2Address(
    "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f", // Factory address (contract creator)
    salt,
    "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" // init code hash
  );

  return address;
};

/*
  Get reserve helper function
*/
export const getUniv2Reserve = async (pair, tokenA, tokenB) => {
  const [token0] = sortTokens(tokenA, tokenB);

  // 获得uniswap pair 的余额 ， 结果是两个 reserve，、
  // 这个 uniswapV2Pair 是 合约， 也就是调用了合约的  getReserves 的函数 
  // 这两个值保存在了 UniswapV2Pair 中的两个变量中了，一个是 reserved0 ,一个是 reserved1.
  // 值需要调用合约把数据读出来就可以了，不需要做什么计算。
  const [reserve0, reserve1] = await uniswapV2Pair.attach(pair).getReserves();

  // 这里的判断只需要知道两个token 有没有对掉过就可以了， 如果没有，原路返回，如果有，就反过来就好了。 
  // 这个算法如此简单，之前想复杂了。
  if (match(tokenA, token0)) {
    return [reserve0, reserve1];
  }
  return [reserve1, reserve0];
};

/*
 Uniswap v2; x * y = k formula

 How much out do we get if we supply in?
*/
export const getUniv2DataGivenIn = (aIn, reserveA, reserveB) => {
  const aInWithFee = aIn.mul(997);
  const numerator = aInWithFee.mul(reserveB);
  const denominator = aInWithFee.add(reserveA.mul(1000));
  const bOut = numerator.div(denominator);

  // Underflow
  let newReserveB = reserveB.sub(bOut);
  if (newReserveB.lt(0) || newReserveB.gt(reserveB)) {
    newReserveB = ethers.BigNumber.from(1);
  }

  // Overflow
  let newReserveA = reserveA.add(aIn);
  if (newReserveA.lt(reserveA)) {
    newReserveA = ethers.constants.MaxInt256;
  }

  return {
    amountOut: bOut,
    newReserveA,
    newReserveB,
  };
};

/*
 Uniswap v2; x * y = k formula

 How much in do we get if we supply out?
*/
export const getUniv2DataGivenOut = (bOut, reserveA, reserveB) => {
  // Underflow
  // 传递进来的第一个参数是 购买的B的最小数量。 
  let newReserveB = reserveB.sub(bOut);
  if (newReserveB.lt(0) || reserveB.gt(reserveB)) {
    newReserveB = ethers.BigNumber.from(1);
  }

  // a 的数量 * 要买的B的数量， * 1000 
  // 购买后的B的存量数量 * 997 
  // a 的数量 * 要买的B的数量， * 1000 / （购买后的B的存量数量 * 997 ）  这个是 (1000/997) * (a数量， * 要买的B数量  / 购买后B存量)
  // 这里算出来的是能够交换出来的A的数量？ 
  const numerator = reserveA.mul(bOut).mul(1000);
  const denominator = newReserveB.mul(997);
  const aAmountIn = numerator.div(denominator).add(ethers.constants.One);

  // Overflow
  // 之前的A 加新购买到的A ， A 是weth 进入到池中， B是token，从池中拿出来。 
  let newReserveA = reserveA.add(aAmountIn);

  // 新的数量， 怎么会小于之前的呢？ 这叫overflow？ 什么情况下才会有overflow呢？ 
  // overflow 之后， 新的A的数量会设置成 MaxInt256, 这为什么要这么做呢？ 
  if (newReserveA.lt(reserveA)) {
    newReserveA = ethers.constants.MaxInt256;
  }

  // 返回的是能交换的A的数量，也就是weth的数量。 
  return {
    amountIn: aAmountIn,
    newReserveA,
    newReserveB,
  };
};

/*
  Given a finalMinRecv BigNumber and a path of tokens (string), compute the
  minRecv immediately after WETH.

  Basically, calculates how much the user is willing to accept as a min output,
  but specifically tailored for the token after WETH.
  计算出用户接受的最小输出，这里监听的uniswap 方法是 swapExactETHforToken , 所以是用固定的eth换token
  那么用户能接受的一个最小数量是多少，就是他的下限，这个下限是根据当前价格和滑点计算出来的，当然我们可以不管用户的滑点的百分比
  直接使用最终价格来计算
  如果是 swapETHforExactToken，那么就是反过来，指定的是一个eth的最大值。

  We do this as Univ2 router swaps can swap over "paths". In this example, we're only doing
  WETH <> TOKEN sandwiches. Thus, we only care about the minRecv for the path DIRECTLY AFTER WETH
  在path 数组里面，我们只关心weth，之后的token。 
  path 我看到的几组数据里面，一般有4个值， 第一个是weth，第二个是要换的token，后面是什么，就不清楚了
  为什么有4个参数呢？ 这真的是很难理解。
  这里只关注weth后面的第一个token，其他的token就不管了。 
*/
export const getUniv2ExactWethTokenMinRecv = async (finalMinRecv, path) => {
  let userMinRecv = finalMinRecv;

  // Only works for swapExactETHForTokens

  // Computes lowest amount of token (directly after WETH)
  for (let i = path.length - 1; i > 1; i--) {
    const fromToken = path[i - 1];
    const toToken = path[i];

    // 获得pair address 地址
    const pair = getUniv2PairAddress(fromToken, toToken);

    // 获得pair address 的余额
    const [reserveFrom, reserveTo] = await getUniv2Reserve(
      pair,
      fromToken,
      toToken
    );

    // 通过传入最小的能够接受的token数量，计算出交换出来的weth的数量， 
    const newReserveData = await getUniv2DataGivenOut(
      userMinRecv,
      reserveFrom,
      reserveTo
    );
    // 这里的 amountIn 是A的数量， 怎么会赋值给  userMinRecv 呢？ 这很奇怪。 这个是B的最小数量。 
    userMinRecv = newReserveData.amountIn;
  }

  return userMinRecv;
};
