import { api, RawRequest, RawResponse } from "encore.dev/api";
import { request, response } from "express";
import { app } from "./index";

Object.setPrototypeOf(request, RawRequest.prototype);
Object.setPrototypeOf(response, RawResponse.prototype);

export const expressApp = api.raw(
  { expose: true, method: "*", path: "/!rest", bodyLimit: null },
  app,
);
