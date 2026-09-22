import { ClobClient } from "@polymarket/clob-client";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import dotenv from "dotenv";
import fs from "fs";
import WebSocket from "ws";

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

const CLOB_URL = "https://clob.polymarket.com";
const RTDS_URL = "wss://ws-live-data.polymarket.com";
const GAMMA_URL = "https://gamma-api.polymarket.com";

const CSV_FILE = "btc_5m_telemetry.csv";
const INTERVAL_MS = 15000;

// -----------------------------------------------------------------------------
// Полимаркет RTDS: Chainlink BTC/USD + 30s/60s TWAP.
// RTDS — публичный websocket, отдельные credentials не нужны.
// -----------------------------------------------------------------------------

const rtdsState = {
    spot: null,
    spotTimestamp: null,

    twap30: null,
    twap30Timestamp: null,

    twap60: null,
    twap60Timestamp: null,

    // Небольшой буфер последних TWAP наблюдений.
    // Нужен, чтобы не потерять стартовое значение, если Gamma ответил чуть позже.
    twapHistory: []
};

let rtdsWs = null;
let rtdsPingTimer = null;
let rtdsReconnectTimer = null;
let rtdsReconnectAttempt = 0;

// -----------------------------------------------------------------------------
// CSV
// -----------------------------------------------------------------------------

function initCsv() {
    if (!fs.existsSync(CSV_FILE)) {
        const headers = [
            "timestamp",
            "market_slug",
            "market_question",
            "market_start",
            "market_end",
            "seconds_remaining",

            "btc_chainlink_spot",
            "btc_chainlink_timestamp",

            "price_to_beat",
            "price_to_beat_window_seconds",
            "price_to_beat_timestamp",
            "distance_to_target_usd",
            "direction",
            "crossed_target",
            "crossing_count",

            "twap30",
            "twap30_timestamp",
            "twap60",
            "twap60_timestamp",

            "up_ask",
            "up_bid",
            "up_mid",

            "down_ask",
            "down_bid",
            "down_mid"
        ].join(",") + "\n";

        fs.writeFileSync(CSV_FILE, headers, "utf8");
        console.log(`Файл статистики создан: ${CSV_FILE}`);
    }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function parseJsonArray(value) {
    if (Array.isArray(value)) return value;

    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    return null;
}

function parseJsonObject(value) {
    if (value && typeof value === "object") return value;

    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
            return null;
        }
    }

    return null;
}

function toFiniteNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function csvValue(value) {
    if (value === null || value === undefined) return "";
    const text = String(value);

    if (
        text.includes(",") ||
        text.includes('"') ||
        text.includes("\n") ||
        text.includes("\r")
    ) {
        return `"${text.replace(/"/g, '""')}"`;
    }

    return text;
}

function getMarketTimestampFromSlug(slug) {
    const match = String(slug || "").match(/btc-updown-5m-(\d{10})$/i);
    if (!match) return null;

    const timestamp = Number(match[1]);
    return Number.isFinite(timestamp) ? timestamp : null;
}

function getTwapLookbackSeconds(market) {
    const candidates = [
        market?.twapLookbackSeconds,
        market?.cryptoMarketConfig?.twapLookbackSeconds,
        market?.raw?.cryptoMarketConfig?.twapLookbackSeconds,
        parseJsonObject(market?.raw)?.cryptoMarketConfig?.twapLookbackSeconds
    ];

    for (const candidate of candidates) {
        const n = Number(candidate);
        if (n === 30 || n === 60) {
            return n;
        }
    }

    return 'UNKNOWN';
}

function extractUpDownTokenIds(market) {
    const tokenIds = parseJsonArray(market?.clobTokenIds);

    if (!tokenIds || tokenIds.length < 2) {
        return null;
    }

    const outcomes = parseJsonArray(market?.outcomes);

    if (outcomes && outcomes.length === tokenIds.length) {
        const normalized = outcomes.map(outcome =>
            String(outcome).trim().toLowerCase()
        );

        const upIndex = normalized.findIndex(x => x === "up");
        const downIndex = normalized.findIndex(x => x === "down");

        if (upIndex >= 0 && downIndex >= 0) {
            return {
                tokenIdUp: tokenIds[upIndex],
                tokenIdDown: tokenIds[downIndex]
            };
        }
    }

    return {
        tokenIdUp: tokenIds[0],
        tokenIdDown: tokenIds[1]
    };
}

function getBestBid(book) {
    return book?.bids?.at(-1)?.price ?? null;
}

function getBestAsk(book) {
    return book?.asks?.at(-1)?.price ?? null;
}

function calcMid(bid, ask) {
    const b = toFiniteNumber(bid);
    const a = toFiniteNumber(ask);

    if (b === null || a === null) return null;
    return ((b + a) / 2).toFixed(4);
}

// -----------------------------------------------------------------------------
// RTDS
// -----------------------------------------------------------------------------

function rememberTwap(windowSeconds, value, timestampMs) {
    if (!Number.isFinite(timestampMs) || value === null) return;

    const item = {
        windowSeconds,
        value: String(value),
        timestampMs
    };

    rtdsState.twapHistory.push(item);

    const cutoff = Date.now() - 90_000;

    while (
        rtdsState.twapHistory.length > 0 &&
        rtdsState.twapHistory[0].timestampMs < cutoff
    ) {
        rtdsState.twapHistory.shift();
    }
}

function handleRtdsMessage(rawMessage) {
    let message;

    try {
        message = JSON.parse(String(rawMessage));
    } catch {
        return;
    }

    if (message?.topic === "crypto_prices_chainlink") {
        const payload = message.payload;

        if (!payload) return;

        const symbol = String(payload.symbol || "").toLowerCase();

        if (symbol !== "btc/usd") return;

        const value = payload.value;
        const timestampMs = Number(payload.timestamp);

        if (value === undefined || !Number.isFinite(timestampMs)) {
            return;
        }

        rtdsState.spot = String(value);
        rtdsState.spotTimestamp = timestampMs;

        return;
    }

    const twapTopicToWindow = {
        crypto_prices_twap_thirty: 30,
        crypto_prices_twap_sixty: 60
    };

    const windowSeconds = twapTopicToWindow[message?.topic];

    if (!windowSeconds) return;
    if (message?.type !== "update") return;

    const payload = message.payload;

    if (!payload) return;

    const symbol = String(payload.symbol || "").toLowerCase();

    if (symbol !== "btc/usd") return;

    const value = payload.full_accuracy_value ?? payload.value;
    const timestampMs = Number(payload.timestamp);

    if (value === undefined || !Number.isFinite(timestampMs)) {
        return;
    }

    rememberTwap(windowSeconds, value, timestampMs);

    if (windowSeconds === 30) {
        rtdsState.twap30 = String(value);
        rtdsState.twap30Timestamp = timestampMs;
    } else {
        rtdsState.twap60 = String(value);
        rtdsState.twap60Timestamp = timestampMs;
    }
}

function connectRtds() {
    if (rtdsReconnectTimer) {
        clearTimeout(rtdsReconnectTimer);
        rtdsReconnectTimer = null;
    }

    if (rtdsPingTimer) {
        clearInterval(rtdsPingTimer);
        rtdsPingTimer = null;
    }

    try {
        rtdsWs = new WebSocket(RTDS_URL);
    } catch (error) {
        scheduleRtdsReconnect(error);
        return;
    }

    rtdsWs.on("open", () => {
        rtdsReconnectAttempt = 0;

        const subscribeFrame = {
            action: "subscribe",
            subscriptions: [
                {
                    topic: "crypto_prices_chainlink",
                    type: "*",
                    filters: JSON.stringify({ symbol: "btc/usd" })
                },
                {
                    topic: "crypto_prices_twap_thirty",
                    type: "update",
                    filters: JSON.stringify({ symbol: "btc/usd" })
                },
                {
                    topic: "crypto_prices_twap_sixty",
                    type: "update",
                    filters: JSON.stringify({ symbol: "btc/usd" })
                }
            ]
        };

        rtdsWs.send(JSON.stringify(subscribeFrame));

        rtdsPingTimer = setInterval(() => {
            if (rtdsWs?.readyState === WebSocket.OPEN) {
                rtdsWs.send("PING");
            }
        }, 5000);

        console.log("RTDS подключён: Chainlink BTC/USD + TWAP 30s/60s");
    });

    rtdsWs.on("message", handleRtdsMessage);

    rtdsWs.on("error", error => {
        console.error("RTDS error:", error.message);
    });

    rtdsWs.on("close", () => {
        if (rtdsPingTimer) {
            clearInterval(rtdsPingTimer);
            rtdsPingTimer = null;
        }

        scheduleRtdsReconnect();
    });
}

function scheduleRtdsReconnect(error) {
    if (rtdsReconnectTimer) return;

    rtdsReconnectAttempt += 1;

    const delay = Math.min(
        30_000,
        1000 * 2 ** Math.min(rtdsReconnectAttempt - 1, 5)
    );

    console.error(
        `RTDS отключён${error ? `: ${error.message}` : ""}. ` +
        `Повторное подключение через ${delay} ms`
    );

    rtdsReconnectTimer = setTimeout(() => {
        rtdsReconnectTimer = null;
        connectRtds();
    }, delay);
}

// -----------------------------------------------------------------------------
// Market discovery
// -----------------------------------------------------------------------------

async function getActiveBtc5mMarket() {
    const nowSec = Math.floor(Date.now() / 1000);

    // slug содержит START текущего окна
    const marketStartSec = Math.floor(nowSec / 300) * 300;
    const slug = `btc-updown-5m-${marketStartSec}`;

    try {
        const eventResponse = await fetch(
            `${GAMMA_URL}/events?slug=${encodeURIComponent(slug)}`
        );

        if (eventResponse.ok) {
            const events = await eventResponse.json();

            if (Array.isArray(events) && events.length > 0) {
                const market = events[0]?.markets?.find(m => !m.closed);

                if (market) {
                    return {
                        market,
                        slug
                    };
                }
            }
        }

        const marketResponse = await fetch(
            `${GAMMA_URL}/markets?slug=${encodeURIComponent(slug)}`
        );

        if (marketResponse.ok) {
            const markets = await marketResponse.json();

            if (Array.isArray(markets)) {
                const market = markets.find(m => !m.closed);

                if (market) {
                    return {
                        market,
                        slug
                    };
                }
            }
        }

        return null;
    } catch (error) {
        console.error("Ошибка получения рынка:", error.message);
        return null;
    }
}

// -----------------------------------------------------------------------------
// Price to Beat
// -----------------------------------------------------------------------------

function getPriceToBeatForMarket(market) {
    const slug = market?.slug || "";
    const startSec = getMarketTimestampFromSlug(slug);

    if (startSec === null) {
        return null;
    }

    const startMs = startSec * 1000;
    const windowSeconds = getTwapLookbackSeconds(market);

    const candidate = rtdsState.twapHistory.find(
        item =>
            item.windowSeconds === windowSeconds &&
            item.timestampMs >= startMs &&
            item.timestampMs < startMs + 15_000
    );

    if (!candidate) {
        return null;
    }

    return {
        value: candidate.value,
        windowSeconds,
        timestampMs: candidate.timestampMs
    };
}

async function getPriceToBeat(market, marketStartMs, marketEndMs) {
    try {
        const eventStartTime = new Date(marketStartMs).toISOString();
        const endDate = new Date(marketEndMs).toISOString();

        const url = new URL(
            "https://polymarket.com/api/crypto/crypto-price"
        );

        url.searchParams.set("symbol", "BTC");
        url.searchParams.set("eventStartTime", eventStartTime);
        url.searchParams.set("variant", "fiveminute");
        url.searchParams.set("endDate", endDate);

        const response = await fetch(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
                    "AppleWebKit/537.36 (KHTML, like Gecko) " +
                    "Chrome/153.0.0.0 Safari/537.36",

                "Accept": "application/json",
                "Referer": "https://polymarket.com/"
            }
        });

        if (!response.ok) {
            const body = await response.text();

            console.error(
                `PriceToBeat HTTP ${response.status}: ${body.slice(0, 300)}`
            );

            return null;
        }

        const data = await response.json();

        const openPrice = Number(data?.openPrice);

        if (!Number.isFinite(openPrice) || openPrice <= 0) {
            console.error(
                "PriceToBeat: openPrice отсутствует:",
                data
            );

            return null;
        }

        return {
            price: openPrice,
            raw: data
        };
    } catch (error) {
        console.error(
            "Ошибка получения Price to Beat:",
            error.message
        );

        return null;
    }
}

// -----------------------------------------------------------------------------
// Main collection
// -----------------------------------------------------------------------------

async function collectData(clobClient) {
    try {
        const result = await getActiveBtc5mMarket();

        if (!result) {
            console.log(
                `[${new Date().toLocaleTimeString()}] ` +
                `⚠️ Текущий BTC 5m market ещё не найден`
            );

            return;
        }

        const { market, slug } = result;

        const marketStartSec = getMarketTimestampFromSlug(slug);

        if (marketStartSec === null) {
            console.log(`⚠️ Некорректный slug рынка: ${slug}`);
            return;
        }

        const marketStartMs = marketStartSec * 1000;
        const marketEndMs = marketStartMs + 300_000;

        const priceToBeatResult = await getPriceToBeat(
            market,
            marketStartMs,
            marketEndMs
        );

        const priceToBeat = priceToBeatResult?.price ?? null;

        const secondsRemaining = Math.max(
            0,
            Math.floor((marketEndMs - Date.now()) / 1000)
        );

        const tokens = extractUpDownTokenIds(market);

        if (!tokens) {
            console.log(
                `⚠️ Не удалось получить UP/DOWN token IDs: ${slug}`
            );

            return;
        }

        const { tokenIdUp, tokenIdDown } = tokens;

        const [orderbookUp, orderbookDown] = await Promise.all([
            clobClient.getOrderBook(tokenIdUp).catch(() => null),
            clobClient.getOrderBook(tokenIdDown).catch(() => null)
        ]);

        const upAsk = getBestAsk(orderbookUp);
        const upBid = getBestBid(orderbookUp);

        const downAsk = getBestAsk(orderbookDown);
        const downBid = getBestBid(orderbookDown);

        const btcSpot = rtdsState.spot;

        const btcSpotNumber = toFiniteNumber(btcSpot);
        const ptbNumber = toFiniteNumber(priceToBeat?.value);

        let distanceToTarget = null;
        let direction = "UNKNOWN";

        if (btcSpotNumber !== null && ptbNumber !== null) {
            distanceToTarget = (
                btcSpotNumber - ptbNumber
            ).toFixed(2);

            if (btcSpotNumber > ptbNumber) {
                direction = "UP";
            } else if (btcSpotNumber < ptbNumber) {
                direction = "DOWN";
            } else {
                direction = "AT_TARGET";
            }
        }

        let marketState = {
            slug: null,
            previousDirection: null,
            crossingCount: 0
        };

        
        if (marketState.slug !== slug) {
            marketState = {
                slug,
                previousDirection: null,
                crossingCount: 0
            };
        }

        if (
            direction !== "UNKNOWN" &&
            marketState.previousDirection !== null &&
            direction !== marketState.previousDirection
        ) {
            marketState.crossingCount += 1;
        }

        marketState.previousDirection = direction;




        const timestamp = new Date().toISOString();
        const marketTitle = market.question || "BTC Up or Down 5m";

        const row = [
            timestamp,
            csvValue(slug),
            csvValue(marketTitle),
            new Date(marketStartMs).toISOString(),
            new Date(marketEndMs).toISOString(),
            secondsRemaining,

            btcSpot ?? "",
            rtdsState.spotTimestamp
                ? new Date(
                    rtdsState.spotTimestamp
                ).toISOString()
                : "",

            priceToBeat?.value ?? "",
            priceToBeat?.windowSeconds ?? "",
            priceToBeat?.timestampMs
                ? new Date(
                    priceToBeat.timestampMs
                ).toISOString()
                : "",

            distanceToTarget ?? "",
            direction,

            rtdsState.twap30 ?? "",
            rtdsState.twap30Timestamp
                ? new Date(
                    rtdsState.twap30Timestamp
                ).toISOString()
                : "",

            rtdsState.twap60 ?? "",
            rtdsState.twap60Timestamp
                ? new Date(
                    rtdsState.twap60Timestamp
                ).toISOString()
                : "",

            upAsk ?? "",
            upBid ?? "",
            calcMid(upBid, upAsk) ?? "",

            downAsk ?? "",
            downBid ?? "",
            calcMid(downBid, downAsk) ?? ""
        ].join(",") + "\n";

        fs.appendFileSync(CSV_FILE, row, "utf8");

        console.log(
            `[${new Date().toLocaleTimeString()}] ` +
            `${slug} | ` +
            `осталось ${secondsRemaining}s | ` +
            `BTC Chainlink $${btcSpot ?? "N/A"} | ` +
            `PTB $${priceToBeat?.value ?? "N/A"} | ` +
            `${direction} | ` +
            `Δ ${distanceToTarget ?? "N/A"} | ` +
            `UP A/B ${upAsk ?? "N/A"}/${upBid ?? "N/A"} | ` +
            `DOWN A/B ${downAsk ?? "N/A"}/${downBid ?? "N/A"}`
        );
    } catch (error) {
        console.error(
            "Ошибка при выполнении сбора:",
            error.message
        );
    }
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

async function start() {
    initCsv();

    console.log("Запуск Polymarket BTC 5m collector...");
    console.log(`Интервал записи: ${INTERVAL_MS / 1000} секунд`);

    // RTDS должен быть подключён ДО начала текущего market window,
    // чтобы поймать Price to Beat.
    connectRtds();

    const authClient = new ClobClient(
        CLOB_URL,
        137,
        walletClient
    );

    const creds = await authClient.createOrDeriveApiKey();

    const clobClient = new ClobClient(
        CLOB_URL,
        137,
        walletClient,
        creds
    );

    console.log("CLOB client готов.");
    console.log("Для остановки нажмите Ctrl + C\n");

    await collectData(clobClient);

    setInterval(() => {
        collectData(clobClient);
    }, INTERVAL_MS);
}

process.on("SIGINT", () => {
    console.log("\nОстанавливаем collector...");

    if (rtdsPingTimer) {
        clearInterval(rtdsPingTimer);
    }

    if (rtdsReconnectTimer) {
        clearTimeout(rtdsReconnectTimer);
    }

    if (rtdsWs) {
        rtdsWs.close();
    }

    process.exit(0);
});

start().catch(error => {
    console.error("Критическая ошибка:", error);
    process.exit(1);
});