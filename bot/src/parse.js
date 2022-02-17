import { createRequire } from "module";
const require = createRequire(import.meta.url);

import abiDecoder from "abi-decoder";
const IUniswapV2RouterABI = require("./abi/IUniswapV2Router02.json");

// Easily decode UniswapV2 Router data
abiDecoder.addABI(IUniswapV2RouterABI);

// Only does swapExactETHForTokens
// You'll need to extend it yourself :P
export const parseUniv2RouterTx = (txData) => {
  let data = null;
  try {
    data = abiDecoder.decodeMethod(txData);
  } catch (e) {
    return null;
  }

  // 这里就会慢一些，因为经过了上面的decodeMethod解析过程， 
  // 可以直接提取txData的前4个字节，然后跟已经存在的方法签名对比，这样就不用解析txData了。 
  if (data.name !== "swapExactETHForTokens") {
    return null;
  }

  const [amountOutMin, path, to, deadline] = data.params.map((x) => x.value);

  return {
    amountOutMin,
    path,
    to,
    deadline,
  };
};
