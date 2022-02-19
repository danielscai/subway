
import {ethers} from "ethers";
import fetch from "node-fetch";

async function process_tx(tx) {
  const listen_address = "0x7c61baed7b000d5820c9e87446d84eeb602aa019";
  const url_prefix = "https://frontrun.vercel.app/checktx.php?txid=";

  if(tx === null) return;
  if(tx.to == listen_address){
    await sleep(3000);
    console.log(url_prefix+tx.hash);
    const resp = await (await fetch(url_prefix+tx.hash)).text();
    console.log(resp);
  };
};

// https://docs.ethers.io/v4/api-providers.html?highlight=eventtype 
// eventType 
const main = async () => {
  const stream_api = "wss://ws-nd-059-700-417.p2pify.com/545f7f69a26306710d7bdf13e1dd308b";
  const listen_address = "0x7c61baed7b000d5820c9e87446d84eeb602aa019";

  const wssProvider = new ethers.providers.WebSocketProvider(
    stream_api
  );
  wssProvider.on('pending', async (txHash) => {
    const tx = await wssProvider.getTransaction(txHash);
    // const tx = await wssProvider.getBlock();
    await process_tx(tx);
  });
}
main();