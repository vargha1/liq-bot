import { ethers } from "ethers";

const provider = new ethers.WebSocketProvider("wss://arbitrum.gateway.tenderly.co/6WQJNkI7JlebpTRelXh2wW");

provider.on("block", (bn) => console.log("New block:", bn));
provider.on("debug", console.log);

setInterval(() => console.log("Still alive, block:", provider.getBlockNumber()), 10000);
