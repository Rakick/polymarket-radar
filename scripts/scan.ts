import { runScan } from "../src/lib/scan";
runScan().then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(r.status === "failed" ? 1 : 0); }).catch((e) => { console.error("Scan en echec :", e); process.exit(1); });
