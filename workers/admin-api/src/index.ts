import { createAccessApiHandler } from "../../shared/src/api";
import { routeAdminApi, type AdminApiEnv } from "./routes";

export interface Env extends AdminApiEnv {}

const handler = createAccessApiHandler<Env>("admin", routeAdminApi);

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return handler(request, env);
  },
};
