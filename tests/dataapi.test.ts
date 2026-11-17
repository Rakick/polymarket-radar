import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchTradesForMarket, normalizeTrade, stableTradeId } from "../src/lib/dataapi";

const r:any={proxy_wallet:"0xW",side:"BUY",token_id:"t",condition_id:"c",size:2,price:.1,timestamp:1,transaction_hash:"h"};

afterEach(() => vi.unstubAllGlobals());

describe("data api",()=>{
  it("normalizes and deduplicates",()=>{
    expect(stableTradeId(r)).toBe(stableTradeId(r));
    expect(normalizeTrade(r,"m")?.usd_amount).toBe(.2);
    expect(normalizeTrade({...r,transaction_hash:""},"m")).toBeNull();
  });

  it("walks the cursor only through the requested time window",async()=>{
    const now=Math.floor(Date.now()/1000);
    const start=now-3600;
    const fetchMock=vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data:[
          {...r,timestamp:now-10,transaction_hash:"new-1"},
          {...r,timestamp:now-20,transaction_hash:"new-2"},
        ],
        pagination:{has_more:true,next_cursor:"cursor-page-2"},
      }),{status:200,headers:{"content-type":"application/json"}}))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data:[{...r,timestamp:start-1,transaction_hash:"old-1"}],
        pagination:{has_more:true,next_cursor:"cursor-page-3"},
      }),{status:200,headers:{"content-type":"application/json"}}));
    vi.stubGlobal("fetch",fetchMock);

    const result=await fetchTradesForMarket({
      condition:"condition-1",marketId:"market-1",startSec:start,endSec:now,
    });

    expect(result.trades).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(result.pages).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const firstUrl=new URL(String(fetchMock.mock.calls[0][0]));
    const secondUrl=new URL(String(fetchMock.mock.calls[1][0]));
    expect(firstUrl.searchParams.has("start")).toBe(false);
    expect(firstUrl.searchParams.has("end")).toBe(false);
    expect(secondUrl.searchParams.get("cursor")).toBe("cursor-page-2");
  });
});
