import { ClobClient } from "@polymarket/clob-client";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

// Жесткий контроль наличия ключа
if (!process.env.PRIVATE_KEY) {
    throw new Error("Критическая ошибка: приватный ключ не найден");
}

const provider = new ethers.JsonRpcProvider("https://polygon-rpc.com/");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const clobClient = new ClobClient(
    "https://clob.polymarket.com",
    137, // Chain ID для Polygon Mainnet
    wallet
);

async function init() {
    try {
        console.log("Генерация API ключей...");
        const creds = await clobClient.createApiKey();
        clobClient.setApiKey(creds);
        console.log("Успешная авторизация! Ключи сессии активны.");
    } catch (error) {
        console.error("Ошибка API:", error.message);
    }
}

init();