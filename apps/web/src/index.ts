import { createApp } from "./app";
import { createD1Repository } from "./d1-repository";

export default createApp({ repository: (env) => createD1Repository(env.DB) });
