/**
 * Express strips the mount path before a mounted router normally handles "/".
 * Encore's raw request bridge can present collection roots with the mount path
 * still in req.url, so root handlers accept both forms.
 */
export function mountedRootPaths(mountPath: string): string[] {
  return ["/", mountPath, `${mountPath}/`];
}
