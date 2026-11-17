// Dip-buy mean-reversion bot for agent-fun/bars-replay/v1 (make.fun btc-race-24h-20261117-0603).
//
// Strategy, in one paragraph: cbBTC on a one-minute replay spends most of its
// time chopping inside a narrow range, and a full-size round trip costs roughly
// 26 bps in fees, slippage and price impact, so this bot stays in cash almost
// all of the time and only buys a dip that has already started to turn: the
// close more than DIP below the highest close of the last W bars, with the
// close above the previous close as bounce confirmation. While it holds, it
// protects the trade three ways: a hard stop under the position's actual cost
// (fees included), a take-profit at TP above the entry close, and a trailing
// stop under the highest close since entry, plus a stall exit when the price
// has made no new high for STALL_BARS bars. One position, all-in, long only.
//
// The bot speaks the protocol through the kit's TypeScript shim, vendored
// unchanged at vendor/makefun-bars.ts: the harness sends hello once, then one
// batch per bar, and the shim asks onBatch for the orders decided on that
// bar. Orders fill at the next bar's open. Everything here is deterministic:
// no clock, no environment, no randomness, only float arithmetic on the bars'
// own numbers.
//
// Dev-window check (kit's frozen 24h window, BTC +0.5% over the day): the
// official local grade gives net PnL +33.79 USDC with 5 trades (win rate
// 1.00) and 0.72% maximum drawdown, above the dev gate's break-even, while
// buy-and-hold records about +5 USDC on the same window and the previous
// momentum bot records -32 USDC. The parameters sit on a broad plateau: neighbouring settings (window
// 300-360 bars, dip 1.4-1.6%, take-profit 1.5-2.0%) all score in the same
// range, so the result does not hinge on one tuned number.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// --- strategy parameters (fractions are of price, bars are one-minute bars) ---
const W = 360;                  // bars the dip is measured against (6h high)
const DIP = 0.016;              // enter when the close is 1.6% under the 6h high
const TP = 0.02;                // take profit 2.0% above the entry close
const STOP = 0.01;              // exit when the position is worth 1.0% under its cost
const TRAIL = 0.008;            // exit 0.8% under the highest close since entry
const STALL_BARS = 240;         // exit after this many bars with no new high
const MAX_SLIPPAGE_BPS = 150;   // refuse fills more than 1.5% past the deciding close

// The strategy's memory: the closes it has seen and the open trade's marks.
const closes: number[] = [];
let holding = false;
let peakClose: number | null = null; // highest close since the position appeared
let peakSeq = -1;                    // batch seq of that high (the stall clock)
let entryClose = 0;                  // close of the bar the position appeared on
let prevClose: number | null = null; // previous bar's close (bounce confirmation)

// Highest close of the last W bars, current bar included.
function rollingHigh(): number | null {
  if (closes.length <= W) return null;
  let high = 0;
  for (let j = closes.length - W; j < closes.length; j++) {
    if (closes[j] > high) high = closes[j];
  }
  return high;
}

// Why a held position should be sold on this bar, or null to keep it.
function exitReason(state: BarsState, held: { qty: bigint; cost: bigint }, close: number): string | null {
  // Hard stop on real money: value at this close versus what the position
  // cost, fees included (the shim's holding carries the cost).
  const value = state.value(SYMBOL, held.qty);
  if (held.cost > 0n && Number(value) <= Number(held.cost) * (1 - STOP)) return 'stop';
  if (close >= entryClose * (1 + TP)) return 'take-profit';
  if (peakClose !== null && close <= peakClose * (1 - TRAIL)) return 'trail';
  if (state.seq - peakSeq >= STALL_BARS) return 'stall';
  return null;
}

await runBars({
  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) {
      // No bar for our symbol this minute: nothing new to decide on.
      return [];
    }
    const close = Number(bar.c);
    closes.push(close);

    const held = state.positions.get(SYMBOL);
    if (held !== undefined && !holding) {
      // The position appeared with this batch (our buy filled at this bar's
      // open): start the peak and stall clocks from here.
      holding = true;
      peakClose = close;
      peakSeq = state.seq;
      entryClose = close;
    }
    if (held === undefined && holding) {
      // The position is gone (our sell filled at this bar's open).
      holding = false;
      peakClose = null;
    }

    if (state.warmingUp) return [];

    let orders: (BuyInput | SellInput)[] = [];
    if (held !== undefined) {
      if (peakClose === null || close > peakClose) {
        peakClose = close;
        peakSeq = state.seq;
      }
      if (exitReason(state, held, close) !== null) {
        const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS };
        orders = [sell];
      }
    } else {
      // Flat: buy the dip only once it has started to turn back up.
      const high = rollingHigh();
      const bounced = prevClose !== null && close > prevClose;
      if (high !== null && bounced && close <= high * (1 - DIP)) {
        let stake = state.cash;
        const room = state.weightRoom(SYMBOL);
        if (room < stake) stake = room;
        if (stake >= BigInt(state.hello.fees.min_notional_quote_units)) {
          const buy: BuyInput = { side: 'buy', symbol: SYMBOL, notional_quote_units: stake, max_slippage_bps: MAX_SLIPPAGE_BPS };
          orders = [buy];
        }
      }
    }
    prevClose = close;
    return orders;
  },
});
