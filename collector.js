import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

if (!process.env.PRIVATE_KEY) {
    throw new Error("Критическая ошибка: PRIVATE_KEY не найден в .env");
}

const account = privateKeyToAccount(process.env.PRIVATE_KEY);
const walletClient = createWalletClient({
    account,
    chain: polygon,
    transport: http("https://polygon-rpc.com/")
});

const CSV_FILE = "btc_5m_telemetry.csv";
const INTERVAL_MS = 15000; // 15 секунд

// Инициализация CSV файла заголовками
function initCsv() {
    if (!fs.existsSync(CSV_FILE)) {
        const headers = [
            "timestamp",
            "market_question",
            "seconds_remaining",
            "btc_spot_binance",
            "up_ask",
            "up_bid",
            "down_ask",
            "down_bid"
        ].join(",") + "\n";
        
        fs.writeFileSync(CSV_FILE, headers, "utf8");
        console.log(`Создан файл для сбора статистики: ${CSV_FILE}`);
    }
}

// Получение текущей спотовой цены BTC с Binance
async function getBtcSpotPrice() {
    try {
        const res = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
        const data = await res.json();
        return parseFloat(data.price).toFixed(2);
    } catch {
        return "N/A";
    }
}

// Поиск актуального 5-минутного рынка BTC
async function getActiveBtc5mMarket() {
    try {
        const response = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100");
        const markets = await response.json();

        // Ищем рынок, где ОБЯЗАТЕЛЬНО есть и BTC (или Bitcoin), и ровно "5m"
        const btcMarket = markets.find(m => 
            m.question && 
            (m.question.includes("BTC") || m.question.includes("Bitcoin")) && 
            (m.question.includes("5m") && m.question.includes("Up or Down"))
        );

        if (!btcMarket) {
            console.log("⚠️ Активный 5-минутный BTC рынок прямо сейчас не найден (возможно, пауза между интервалами)...");
            return null;
        }

        return btcMarket;
    } catch (e) {
        console.error("Ошибка при поиске рынка:", e.message);
        return null;
    }
}



async function collectData(clobClient) {
    try {
        const market = await getActiveBtc5mMarket();
        if (!market) return;

        const clobTokenIds = JSON.parse(market.clobTokenIds);
        const tokenIdUp = clobTokenIds[0];
        const tokenIdDown = clobTokenIds[1];

        // Расчет оставшегося времени в секундах
        const endDate = new Date(market.endDate || Date.now() + 300000);
        const secondsRemaining = Math.max(0, Math.floor((endDate - Date.now()) / 1000));

        // Запрос стаканов цен
        const [orderbookUp, orderbookDown, btcPrice] = await Promise.all([
            clobClient.getOrderBook(tokenIdUp),
            clobClient.getOrderBook(tokenIdDown),
            getBtcSpotPrice()
        ]);

        const upAsk = orderbookUp.asks?.[0]?.price || "N/A";
        const upBid = orderbookUp.bids?.[0]?.price || "N/A";
        const downAsk = orderbookDown.asks?.[0]?.price || "N/A";
        const downBid = orderbookDown.bids?.[0]?.price || "N/A";

        const timestamp = new Date().toISOString();

        // Формирование строки CSV
        const row = [
            timestamp,
            `"${market.question.replace(/"/g, '""')}"`,
            secondsRemaining,
            btcPrice,
            upAsk,
            upBid,
            downAsk,
            downBid
        ].join(",") + "\n";

        fs.appendFileSync(CSV_FILE, row, "utf8");

        console.log(`[${new Date().toLocaleTimeString()}] Записано | Осталось: ${secondsRemaining}s | BTC: $${btcPrice} | Up (Ask/Bid): ${upAsk}/${upBid} | Down (Ask/Bid): ${downAsk}/${downBid}`);

    } catch (error) {
        console.error("Ошибка при сборе данных:", error.message);
    }
}

async function start() {
    initCsv();

    const authClient = new ClobClient("https://clob.polymarket.com", 137, walletClient);
    const creds = await authClient.createOrDeriveApiKey();
    const clobClient = new ClobClient("https://clob.polymarket.com", 137, walletClient, creds);

    console.log("Авторизация прошла успешно. Начинаем сбор статистики каждые 15 секунд...");
    console.log("Для остановки нажмите Ctrl + C\n");

    // Первый запуск сразу
    await collectData(clobClient);

    // Запуск цикла каждые 15 секунд
    setInterval(() => collectData(clobClient), INTERVAL_MS);
}

start();