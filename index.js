import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import dotenv from "dotenv";

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

// Поиск актуального 5-минутного рынка BTC
async function getBtc5mMarket() {
    // Запрашиваем открытые события Polymarket
    const response = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=50");
    const markets = await response.json();

    // Ищем рынок, содержащий в названии "BTC" и "5m" (или "Up or Down")
    const btcMarket = markets.find(m => 
        m.question && 
        (m.question.includes("BTC") || m.question.includes("Bitcoin")) && 
        m.question.includes("5m")
    );

    if (!btcMarket) {
        // Если прямого совпадения нет, выводим первый доступный быстрый рынок
        console.log("5-минутный BTC рынок не найден в топе, берем первый доступный рынок...");
        return markets[0];
    }

    return btcMarket;
}

async function main() {
    try {
        // 1. Авторизация L1/L2
        const authClient = new ClobClient("https://clob.polymarket.com", 137, walletClient);
        const creds = await authClient.createOrDeriveApiKey();

        const clobClient = new ClobClient(
            "https://clob.polymarket.com",
            137,
            walletClient,
            creds
        );

        console.log("Успешная авторизация!");

        // 2. Получаем 5-минутный рынок
        const market = await getBtc5mMarket();
        const clobTokenIds = JSON.parse(market.clobTokenIds);
        
        // clobTokenIds[0] — это токен "Up / Yes", clobTokenIds[1] — "Down / No"
        const tokenIdUp = clobTokenIds[0];

        console.log(`\n Выбран рынок: "${market.question}"`);
        console.log(`TokenID (Up): ${tokenIdUp}`);

        // 3. Читаем стакан
        const orderbook = await clobClient.getOrderBook(tokenIdUp);
        console.log("Лучший Bid:", orderbook.bids?.[0] || "Нет");
        console.log("Лучший Ask:", orderbook.asks?.[0] || "Нет");

        // 4. ТЕСТОВАЯ ОТПРАВКА ОРДЕРА (БЕЗОПАСНАЯ)
        // Ставим лимитный ордер на покупку 5 акций по цене $0.02 (всего $0.10 риса)
        // Предохранитель: цена $0.02 гарантирует, что ордер просто встанет в стакан и не исполнится
        console.log("\n Отправка тестового лимитного ордера (BUY @ $0.02)...");
        
        const signedOrder = await clobClient.createOrder({
            tokenID: tokenIdUp,
            price: 0.02,        // Цена 2 цента за токен
            side: Side.BUY,     // Покупка
            size: 5             // Количество токенов (минимум обычно $1 суммарно или 5 токенов)
        });

        // Отправляем ордер со стилем Good 'Til Cancelled (GTC)
        const response = await clobClient.postOrder(signedOrder, OrderType.GTC);
        
        console.log("Ответ сервера Polymarket:", response);

        if (response.success) {
            console.log(`\n УСПЕХ! Ордер размещен. Order ID: ${response.orderID}`);
            
            // Сразу отменяем тестовый ордер, чтобы не замусоривать стакан
            console.log("Отмена тестового ордера...");
            const cancelRes = await clobClient.cancelOrder({ orderID: response.orderID });
            console.log("Результат отмены:", cancelRes);
        }

    } catch (error) {
        console.error("Ошибка исполнения:", error);
    }
}

main();