import { ethers } from "ethers";
import { parseUnits } from "@ethersproject/units";
import { getUniv2DataGivenIn } from "./univ2.js";

const BN_18 = parseUnits("1");

/*
  Binary search to find optimal sandwichable amount

  Using binary search here as the profit function isn't normally distributed
  使用二分查找的原因是利润函数不是正态分布的，这个还不是特别理解。 
*/
export const binarySearch = (
  left, // Lower bound
  right, // Upper bound
  calculateF, // Generic calculate function
  passConditionF, // Condition checker
  tolerance = parseUnits("0.01") // Tolerable delta (in %, in 18 dec, i.e. parseUnits('0.01') means left and right delta can be 1%)
) => {
  if (right.sub(left).gt(tolerance.mul(right.add(left).div(2)).div(BN_18))) {
    const mid = right.add(left).div(2);
    const out = calculateF(mid);

    // If we pass the condition
    // Number go up
    // 如果通过测试则开始查找中间值到最大值。 
    // 递归调用自己。 
    if (passConditionF(out)) {
      return binarySearch(mid, right, calculateF, passConditionF, tolerance);
    }

    // 如果没通过，则查找最小值到中间值。 
    // 这样的话，跟你设置的最大值和最小值，有很大的关系，查找效率也会因为最大值设置的过大而变慢， 
    // 这里真的只能用二分查找，而不能直接计算吗？ 这为什么感觉不太对呢。 
    // Number go down
    return binarySearch(left, mid, calculateF, passConditionF, tolerance);
  }

  // No negatives
  const ret = right.add(left).div(2);
  if (ret.lt(0)) {
    return ethers.constants.Zero;
  }

  return ret;
};

/*
  Calculate the max sandwich amount
*/

export const calcSandwichOptimalIn = (
  userAmountIn,
  userMinRecvToken,
  reserveWeth,
  reserveToken
) => {
  // Note that user is going from WETH -> TOKEN
  // So, we'll be pushing the price of TOKEn
  // by swapping WETH -> TOKEN before the user
  // i.e. Ideal tx placement:
  // 1. (Ours) WETH -> TOKEN (pushes up price)
  // 2. (Victim) WETH -> TOKEN (pushes up price more)
  // 3. (Ours) TOKEN -> WETH (sells TOKEN for slight WETH profit)
  const calcF = (amountIn) => {

    // 抢跑状态，就是我们先购买的状态。 
    // amountIn 是我们购买的ETH的金额，这是固定的。 
    // 这个 amountIn， 这里是定义了一个函数 calcF
    const frontrunState = getUniv2DataGivenIn(
      amountIn,
      reserveWeth,
      reserveToken
    );

    // userAmountIn 是用户购买金额
    // victimState 就是用户购买后的状态了。 
    // 返回值是用户购买后，能够返回的数量， 这里难道是token b 的数量？ 
    const victimState = getUniv2DataGivenIn(
      userAmountIn,
      frontrunState.newReserveA,
      frontrunState.newReserveB
    );
    return victimState.amountOut;
  };

  // Our binary search must pass this function
  // i.e. User must receive at least min this
  // 二分查找后的结果，需要满足数量大于用户设置的最小值。 
  const passF = (amountOut) => amountOut.gte(userMinRecvToken);

  // Lower bound will be 0
  // Upper bound will be 100 ETH (hardcoded, or however much ETH you have on hand)
  // Feel free to optimize and change it
  // It shouldn't be hardcoded hehe....
  const lowerBound = parseUnits("0");
  const upperBound = parseUnits("100");

  // Optimal WETH in to push reserve to the point where the user
  // _JUST_ receives their min recv
  // 用户刚好能够收到他的最小值，找到这个最佳的weth 输入。 
  // 这个过程叫binanrysearch 二分查找法，通过二分查找法找到这个最佳值。 
  const optimalWethIn = binarySearch(lowerBound, upperBound, calcF, passF);

  return optimalWethIn;
};

export const calcSandwichState = (
  optimalSandwichWethIn,
  userWethIn,
  userMinRecv,
  reserveWeth,
  reserveToken
) => {
  // 本地模拟计算3次交换之后的状态。 
  const frontrunState = getUniv2DataGivenIn(
    optimalSandwichWethIn,
    reserveWeth,
    reserveToken
  );
  const victimState = getUniv2DataGivenIn(
    userWethIn,
    frontrunState.newReserveA,
    frontrunState.newReserveB
  );
  const backrunState = getUniv2DataGivenIn(
    frontrunState.amountOut,
    victimState.newReserveB,
    victimState.newReserveA
  );

  //检查最小值条件是满足的。 
  // Sanity check
  if (victimState.amountOut.lt(userMinRecv)) {
    return null;
  }

  // Return
  return {
    // NOT PROFIT
    // Profit = post gas
    // 计算利润，这里没有计算gas费
    // 计算最优的输入值，
    // 用户购买的weth数量，
    // 用户最小token数量。 
    // 3次运行前后的状态。 
    revenue: backrunState.amountOut.sub(optimalSandwichWethIn),
    optimalSandwichWethIn,
    userAmountIn: userWethIn,
    userMinRecv,
    reserveState: {
      reserveWeth,
      reserveToken,
    },
    frontrun: frontrunState,
    victim: victimState,
    backrun: backrunState,
  };
};
