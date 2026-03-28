import 'dotenv/config';
import { ClobClient } from "@polymarket/clob-client";

const clobBase = process.env.PM_CLOB_URL || "https://clob.polymarket.com";
const client = new ClobClient(clobBase);

// Bayern PM token from the trade record
const tokenId = "74445622413742581969428964195329871390934829876986732369770021587825867611492";

// Check open orders and recent trades for this token
try {
  const book = await client.getOrderBook(tokenId);
  process.stdout.write("Orderbook for Bayern PM token:\n");
  process.stdout.write("  Bids: " + JSON.stringify(book.bids?.slice(0, 5)) + "\n");
  process.stdout.write("  Asks: " + JSON.stringify(book.asks?.slice(0, 5)) + "\n");
} catch(e: any) { process.stdout.write("Book error: " + e.message + "\n"); }

// Get recent trades
try {
  const trades = await client.getTrades({ asset_id: tokenId });
  process.stdout.write("\nRecent PM trades for this token (" + (trades as any[]).length + "):\n");
  (trades as any[]).slice(-10).forEach((t: any) => {
    process.stdout.write("  " + t.match_time + " side=" + t.side + " size=" + t.size + " price=" + t.price + "\n");
  });
} catch(e: any) { process.stdout.write("Trades error: " + e.message + "\n"); }
