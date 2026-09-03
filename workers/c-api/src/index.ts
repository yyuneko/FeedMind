import { createAccessApiHandler } from "../../shared/src/api";
import { routeClientApi, type ClientApiEnv } from "./routes";

export interface Env extends ClientApiEnv {}

const handler = createAccessApiHandler<Env>("client", routeClientApi);

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handler(request, env);
  },
};
