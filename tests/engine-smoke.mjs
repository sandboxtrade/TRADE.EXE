import { LocalTransport, FreeMarketLegacyRoom, FREE_MARKET } from "../features/market.js";
import { parseMoneyInput } from "../core/money.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

for (const leverage of [1, 3, 10]) {
  const transport = new LocalTransport({
    startingCapital: 1000,
    seed: 1234 + leverage,
    leverage,
    warmupTicks: 0,
    durationTicks: 400,
    playerCount: 100,
  });

  let snapshot = transport.snapshot();
  assert(Number.isFinite(snapshot.price), `price must be finite at ${leverage}x`);

  let result = await transport.send({ type: "TRADE", action: "BUY", notional: 200, reason: "smoke" });
  assert(result.ok, `BUY must be accepted at ${leverage}x`);
  transport.room.advance(25);

  snapshot = transport.snapshot();
  assert(snapshot.you && Number.isFinite(snapshot.you.equity), `equity must be finite at ${leverage}x`);

  result = await transport.send({ type: "TRADE", action: "CLOSE", fraction: 1, reason: "smoke-close" });
  assert(result.ok, `CLOSE must be accepted at ${leverage}x`);
  transport.room.advance(2);

  const market = transport.room._room.market;
  assert(Math.abs(market.sumEquity() - market.C) < 1e-3, `capital invariant failed at ${leverage}x`);
  transport.stop();
}

const free = new FreeMarketLegacyRoom({ startingCapital: 500, seed: 9001, attachHuman: true });
assert(free._room.market.players.length === FREE_MARKET.botCount + 1, "Free Market player count mismatch");

let freeSnapshot = free.snapshotFor(0);
assert(freeSnapshot.freeMarket === true && freeSnapshot.you, "Free Market snapshot missing human");

const sell = free.send(0, { type: "TRADE", action: "SELL", notional: 100, reason: "smoke" });
assert(sell.ok, "Free Market SELL must be accepted");
free.advance(10);
freeSnapshot = free.snapshotFor(0);
assert(Number.isFinite(freeSnapshot.you.equity), "Free Market equity must be finite");

const exit = free.detachHuman();
assert(Number.isFinite(exit.equity) && exit.equity >= 0, "Free Market exit equity invalid");
assert(Math.abs(free._room.market.sumEquity() - free._room.market.C) < 1e-2, "Free Market capital invariant failed");

assert(parseMoneyInput("100,50") === 100.5, "comma money parsing failed");
assert(parseMoneyInput("1.2.3") === 1.23, "duplicate decimal parsing failed");

console.log("engine-smoke: OK");
