import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import dotenv from "dotenv";

dotenv.config();

if (!process.env.PRIVATE_KEY) {
    throw new Error("Критическая ошибка: PRIVATE_KEY не найден в .env");
}

// 1. Инициализируем аккаунт и сетевой клиент через viem
const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http("https://polygon-rpc.com/")
});

async function init() {
    try {
        console.log("Авторизация и получение API-ключей...");
        
        // 2. Временный клиент для получения API-ключей (L1 auth)
        const authClient = new ClobClient(
            "https://clob.polymarket.com",
            137,
            walletClient
        );

        // Получаем или генерируем API-ключи (key, secret, passphrase)
        const creds = await authClient.createOrDeriveApiKey();

        // 3. Создаем основной рабочий клиент, передавая creds 4-м аргументом (L2 auth)
        const clobClient = new ClobClient(
            "https://clob.polymarket.com",
            137,
            walletClient,
            creds
        );
        
        console.log("Успешная авторизация!");
        console.log("Адрес кошелька:", account.address);
        console.log("Сгенерированные API-ключи:", creds);

    } catch (error) {
        console.error("Ошибка авторизации:", error);
    }
}

init();