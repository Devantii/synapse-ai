package ai.synapse.android.core;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Talks to the Synapse device API with a revocable device key (never the user's password).
 * Plain java.net so it runs (and is tested) on any JVM, not just Android.
 */
public final class SynapseApi {

    /** A failed request with a message suitable for showing to the user. */
    public static final class ApiException extends Exception {
        public final int status;

        public ApiException(String message, int status) {
            super(message);
            this.status = status;
        }
    }

    /** Result of GET /api/device/ping. */
    public static final class Ping {
        public final String user;
        public final String device;
        public final boolean usageConsent;

        Ping(String user, String device, boolean usageConsent) {
            this.user = user;
            this.device = device;
            this.usageConsent = usageConsent;
        }
    }

    private final String server;
    private final String key;

    public SynapseApi(String server, String key) {
        this.server = normalizeServer(server);
        this.key = key == null ? "" : key.trim();
    }

    /** Trims spaces and trailing slashes; adds https:// if no scheme was typed. */
    public static String normalizeServer(String s) {
        String out = s == null ? "" : s.trim();
        while (out.endsWith("/")) out = out.substring(0, out.length() - 1);
        if (!out.isEmpty() && !out.startsWith("http://") && !out.startsWith("https://")) out = "https://" + out;
        return out;
    }

    public Ping ping() throws ApiException {
        String body = request("GET", "/api/device/ping", null);
        return new Ping(field(body, "user"), field(body, "device"), body.contains("\"usageConsent\":true"));
    }

    /** Uploads the JSON from {@link Payload#toJson}; returns the number of entries the server stored. */
    public int uploadUsage(String json) throws ApiException {
        String body = request("PUT", "/api/device/usage", json);
        Matcher m = Pattern.compile("\"entries\"\\s*:\\s*(\\d+)").matcher(body);
        return m.find() ? Integer.parseInt(m.group(1)) : 0;
    }

    private String request(String method, String path, String json) throws ApiException {
        if (server.isEmpty()) throw new ApiException("Add your Synapse server address first.", 0);
        if (!key.startsWith("syn_")) throw new ApiException("Paste the device key from Synapse > Privacy (it starts with syn_).", 0);
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(server + path).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(15000);
            c.setReadTimeout(20000);
            c.setRequestProperty("Authorization", "Bearer " + key);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("User-Agent", "SynapseAndroid/1.0");
            if (json != null) {
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                c.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = c.getOutputStream()) {
                    os.write(bytes);
                }
            }
            int status = c.getResponseCode();
            String body = read(status >= 400 ? c.getErrorStream() : c.getInputStream());
            if (status >= 400) {
                String err = field(body, "error");
                throw new ApiException(err != null ? err : "The server replied " + status + ".", status);
            }
            return body;
        } catch (ApiException e) {
            throw e;
        } catch (IOException e) {
            throw new ApiException("Couldn't reach " + server + ". Check the address and your internet connection.", 0);
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream is = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = is.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString(StandardCharsets.UTF_8.name());
        }
    }

    /** Reads a top-level string field from a small JSON object. */
    static String field(String json, String name) {
        Matcher m = Pattern.compile("\"" + Pattern.quote(name) + "\"\\s*:\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(json == null ? "" : json);
        if (!m.find()) return null;
        return m.group(1).replace("\\\"", "\"").replace("\\\\", "\\").replace("\\n", "\n");
    }
}
