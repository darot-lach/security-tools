// ZAP script-based authentication for user-account-service.
// Login is two steps: POST /api/entrance/login (username/password) returns a
// short-lived "token" cookie carrying a TOTP challenge, then POST /api/totp/verify
// (with that cookie + a computed TOTP code) returns the real session cookies.
// See AuthenticationService#handleLogInWithMFA / TOTPController#verifyTOTP.

function authenticate(helper, paramsValues, credentials) {
    var targetUrl = paramsValues.get("Target URL");
    var username = credentials.getParam("Username");
    var password = credentials.getParam("Password");
    var totpSecret = credentials.getParam("TOTP Secret");

    var loginMsg = helper.prepareMessage();
    var loginUri = new org.apache.commons.httpclient.URI(targetUrl + "/api/entrance/login", false);
    loginMsg.setRequestHeader(new org.parosproxy.paros.network.HttpRequestHeader(
        org.parosproxy.paros.network.HttpRequestHeader.POST,
        loginUri,
        org.parosproxy.paros.network.HttpHeader.HTTP11));
    loginMsg.getRequestHeader().setHeader("Content-Type", "application/json");
    loginMsg.getRequestHeader().setHeader("Frontend-Name", "SPA");
    var loginBody = JSON.stringify({ username: username, password: password, rememberMe: false });
    loginMsg.setRequestBody(loginBody);
    loginMsg.getRequestHeader().setContentLength(loginMsg.getRequestBody().length());

    helper.sendAndReceive(loginMsg, false);

    var totpToken = extractCookieValue(loginMsg, "token");
    if (totpToken === null) {
        // No MFA challenge cookie: either MFA is disabled or credentials were rejected.
        // Either way there is no second step to perform.
        return loginMsg;
    }

    var code = generateTotp(totpSecret);

    var verifyMsg = helper.prepareMessage();
    var verifyUri = new org.apache.commons.httpclient.URI(targetUrl + "/api/totp/verify", false);
    verifyMsg.setRequestHeader(new org.parosproxy.paros.network.HttpRequestHeader(
        org.parosproxy.paros.network.HttpRequestHeader.POST,
        verifyUri,
        org.parosproxy.paros.network.HttpHeader.HTTP11));
    verifyMsg.getRequestHeader().setHeader("Content-Type", "application/json");
    verifyMsg.getRequestHeader().setHeader("Frontend-Name", "SPA");
    verifyMsg.getRequestHeader().setHeader("Cookie", "token=" + totpToken);
    var verifyBody = JSON.stringify({ code: code });
    verifyMsg.setRequestBody(verifyBody);
    verifyMsg.getRequestHeader().setContentLength(verifyMsg.getRequestBody().length());

    helper.sendAndReceive(verifyMsg, false);

    return verifyMsg;
}

function getRequiredParamsNames() {
    return ["Target URL"];
}

function getOptionalParamsNames() {
    return [];
}

function getCredentialsParamsNames() {
    return ["Username", "Password", "TOTP Secret"];
}

function extractCookieValue(msg, cookieName) {
    var headers = msg.getResponseHeader().getHeaders("Set-Cookie");
    if (headers === null) {
        return null;
    }
    var prefix = cookieName + "=";
    for (var i = 0; i < headers.size(); i++) {
        var header = String(headers.get(i));
        if (header.startsWith(prefix)) {
            var end = header.indexOf(";");
            return end === -1 ? header.substring(prefix.length) : header.substring(prefix.length, end);
        }
    }
    return null;
}

// RFC 4648 base32 decode (no padding characters expected in a TOTP secret).
function base32Decode(input) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    var result = input;
    while (result.endsWith('=')) {
        result = result.slice(0, -1);
    }
    input = result.toUpperCase();

    var bits = "";
    for (var i = 0; i < input.length; i++) {
        var val = alphabet.indexOf(input.charAt(i));
        if (val < 0) {
            continue;
        }
        bits += padLeft(val.toString(2), 5, "0");
    }

    var bytes = [];
    for (var j = 0; j + 8 <= bits.length; j += 8) {
        bytes.push(Number.parseInt(bits.substring(j, j + 8), 2));
    }
    return bytes;
}

function padLeft(str, len, ch) {
    while (str.length < len) {
        str = ch + str;
    }
    return str;
}

function toSignedByte(value) {
    return (value << 24) >> 24;
}

// RFC 6238 TOTP, 30s step, 6 digits, HMAC-SHA1 (matches TOTPService).
function generateTotp(secretBase32) {
    var keyBytes = base32Decode(secretBase32);
    var key = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, keyBytes.length);
    for (var i = 0; i < keyBytes.length; i++) {
        key[i] = toSignedByte(keyBytes[i]);
    }

    var timeStep = 30;
    var counter = Math.floor(java.lang.System.currentTimeMillis() / 1000 / timeStep);

    var counterBytes = java.lang.reflect.Array.newInstance(java.lang.Byte.TYPE, 8);
    for (var k = 7; k >= 0; k--) {
        counterBytes[k] = toSignedByte(counter & 0xff);
        counter = Math.floor(counter / 256);
    }

    var mac = javax.crypto.Mac.getInstance("HmacSHA1");
    var keySpec = new javax.crypto.spec.SecretKeySpec(key, "HmacSHA1");
    mac.init(keySpec);
    var hash = mac.doFinal(counterBytes);

    var offset = hash[hash.length - 1] & 0xf;
    var binary =
        ((hash[offset] & 0x7f) << 24) |
        ((hash[offset + 1] & 0xff) << 16) |
        ((hash[offset + 2] & 0xff) << 8) |
        (hash[offset + 3] & 0xff);

    var otp = "" + (binary % 1000000);
    return padLeft(otp, 6, "0");
}
