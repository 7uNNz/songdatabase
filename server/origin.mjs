function header(headers, name) {
    if (typeof headers.get === "function") return headers.get(name);
    return headers[name.toLowerCase()];
}

export function originMatches(headers, requestUrl) {
    try {
        const origin = new URL(header(headers, "origin"));
        const request = new URL(requestUrl);
        const forwardedHost = header(headers, "x-forwarded-host")?.split(",")[0].trim();
        const forwardedProto = header(headers, "x-forwarded-proto")?.split(",")[0].trim();
        const host = forwardedHost || header(headers, "host") || request.host;
        const protocol = forwardedProto || request.protocol.replace(/:$/, "");
        return origin.origin === `${protocol}://${host}`;
    } catch {
        return false;
    }
}
