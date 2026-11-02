import { createApp } from "./app";
import { createMemoryRepository } from "./repository";

// TODO(#5): events テーブルが入ったら D1 実装に差し替える。今は空のデータで動かす
const empty = createMemoryRepository([]);

export default createApp({ repository: () => empty });
