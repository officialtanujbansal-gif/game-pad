package com.omnisync.tvremote

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.core.app.NotificationCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.SecureRandom
import java.util.UUID
import java.util.concurrent.TimeUnit

class TvConnectionService : Service() {
    companion object {
        const val EXTRA_RELAY_URL = "relay_url"
        const val ACTION_STATUS = "com.omnisync.tvremote.STATUS"
        const val ACTION_PAIR_REQUEST = "com.omnisync.tvremote.PAIR_REQUEST"
        const val ACTION_PAIR_DECISION = "com.omnisync.tvremote.PAIR_DECISION"
        const val ACTION_REFRESH_CAPABILITIES = "com.omnisync.tvremote.REFRESH_CAPABILITIES"
        private const val CHANNEL_ID = "omni_remote_connection"
        private const val NOTIFICATION_ID = 711
    }

    private val handler = Handler(Looper.getMainLooper())
    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .retryOnConnectionFailure(true)
        .build()
    private var socket: WebSocket? = null
    private var retryDelay = 2_000L
    private var intentionalStop = false

    private val pairDecisionReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val requestId = intent.getStringExtra("requestId") ?: return
            val approved = intent.getBooleanExtra("approved", false)
            sendMessage(JSONObject()
                .put("type", "pair_decision")
                .put("requestId", requestId)
                .put("approved", approved))
        }
    }

    private val capabilityRefreshReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            publishCapabilities()
        }
    }

    private val reconnect = Runnable { connect() }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        val filter = IntentFilter(ACTION_PAIR_DECISION)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(pairDecisionReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(pairDecisionReceiver, filter)

        val capabilityFilter = IntentFilter(ACTION_REFRESH_CAPABILITIES)
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(capabilityRefreshReceiver, capabilityFilter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(capabilityRefreshReceiver, capabilityFilter)
    }

    @Suppress("DEPRECATION")
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        intentionalStop = false
        startAsForeground()
        val incoming = intent?.getStringExtra(EXTRA_RELAY_URL)
        if (!incoming.isNullOrBlank()) {
            getSharedPreferences("omni_remote", Context.MODE_PRIVATE).edit().putString("relay_url", incoming.trim()).apply()
        }
        connect()
        return START_STICKY
    }

    private fun startAsForeground() {
        val notification = buildNotification("Waiting for relay configuration")
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= 26) {
            val channel = NotificationChannel(CHANNEL_ID, "OmniRemote TV connection", NotificationManager.IMPORTANCE_LOW).apply {
                description = "Keeps the secure TV remote connection active"
            }
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    private fun buildNotification(line: String): Notification {
        val openApp = PendingIntent.getActivity(
            this, 1, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle("OmniRemote TV")
            .setContentText(line)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .build()
    }

    private fun updateNotification(line: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, buildNotification(line))
        broadcastStatus(line)
    }

    private fun connect() {
        if (intentionalStop || socket != null) return
        val prefs = getSharedPreferences("omni_remote", Context.MODE_PRIVATE)
        val configured = prefs.getString("relay_url", null)
        if (configured.isNullOrBlank()) {
            updateNotification("Open the TV app and enter the relay URL")
            return
        }
        val url = configured.trim().let { if (it.endsWith("/ws")) it else it.trimEnd('/') + "/ws" }
        if (!url.startsWith("wss://")) {
            updateNotification("Relay must use WSS for remote internet access")
            return
        }
        val request = try { Request.Builder().url(url).build() } catch (_: Exception) {
            updateNotification("Relay URL is not valid")
            return
        }

        updateNotification("Connecting securely to relay…")
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                retryDelay = 2_000L
                updateNotification("Secure relay connected")
                webSocket.send(JSONObject()
                    .put("type", "tv_hello")
                    .put("deviceId", deviceId())
                    .put("deviceToken", deviceToken())
                    .put("deviceName", deviceName())
                    .put("platform", platformName())
                    .toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(webSocket, text)
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                socket = null
                updateNotification("Relay disconnected. Reconnecting…")
                scheduleReconnect()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                socket = null
                updateNotification("Relay unavailable. Reconnecting…")
                scheduleReconnect()
            }
        })
    }

    private fun handleMessage(webSocket: WebSocket, raw: String) {
        val message = try { JSONObject(raw) } catch (_: Exception) { return }
        when (message.optString("type")) {
            "tv_ready" -> {
                updateNotification("TV online · waiting for phone pairing")
                broadcastStatus("TV online · waiting for pairing", capability = capabilitySummary())
                publishCapabilities()
            }
            "pairing_code" -> broadcastStatus("Waiting for phone pairing", message.optString("code"))
            "pair_request" -> {
                val event = Intent(ACTION_PAIR_REQUEST)
                    .setPackage(packageName)
                    .putExtra("requestId", message.optString("requestId"))
                    .putExtra("remoteName", message.optString("remoteName"))
                sendBroadcast(event)
                updateNotification("Phone pairing request requires TV approval")
            }
            "control" -> executeControl(webSocket, message)
            "error" -> updateNotification(message.optString("message", "Relay error"))
        }
    }

    private fun capabilitySummary(): String = when {
        Build.VERSION.SDK_INT >= 33 && RemoteAccessibilityService.isActive() -> "Full system D-pad actions available on this Android version."
        Build.VERSION.SDK_INT >= 33 -> "Enable OmniRemote under Accessibility to activate D-pad actions."
        else -> "This TV OS is older than Android 13. Full system D-pad injection is not exposed by this receiver."
    }

    private fun publishCapabilities() {
        if (socket == null) return
        sendMessage(JSONObject()
            .put("type", "tv_capabilities")
            .put("apiLevel", Build.VERSION.SDK_INT)
            .put("androidVersion", Build.VERSION.RELEASE)
            .put("dpad", Build.VERSION.SDK_INT >= 33)
            .put("accessibilityEnabled", RemoteAccessibilityService.isActive())
            .put("platform", platformName()))
    }

    private fun executeControl(webSocket: WebSocket, message: JSONObject) {
        val action = message.optString("action")
        val result = RemoteAccessibilityService.execute(this, action)
        webSocket.send(JSONObject()
            .put("type", "command_result")
            .put("id", message.optString("id"))
            .put("action", action)
            .put("success", result.success)
            .put("reason", result.reason)
            .toString())
    }

    private fun sendMessage(message: JSONObject) {
        socket?.send(message.toString())
    }

    private fun scheduleReconnect() {
        if (intentionalStop) return
        handler.removeCallbacks(reconnect)
        handler.postDelayed(reconnect, retryDelay)
        retryDelay = (retryDelay * 2).coerceAtMost(30_000L)
    }

    private fun broadcastStatus(status: String, code: String? = null, capability: String? = null) {
        val event = Intent(ACTION_STATUS).setPackage(packageName).putExtra("status", status)
        if (!code.isNullOrBlank()) event.putExtra("code", code)
        if (!capability.isNullOrBlank()) event.putExtra("capability", capability)
        sendBroadcast(event)
    }

    private fun deviceId(): String {
        val prefs = getSharedPreferences("omni_remote", Context.MODE_PRIVATE)
        var id = prefs.getString("device_id", null)
        if (id.isNullOrBlank()) {
            id = UUID.randomUUID().toString().replace("-", "")
            prefs.edit().putString("device_id", id).apply()
        }
        return id
    }

    private fun deviceToken(): String {
        val prefs = getSharedPreferences("omni_remote", Context.MODE_PRIVATE)
        var token = prefs.getString("device_token", null)
        if (token.isNullOrBlank()) {
            val bytes = ByteArray(32)
            SecureRandom().nextBytes(bytes)
            token = android.util.Base64.encodeToString(bytes, android.util.Base64.URL_SAFE or android.util.Base64.NO_WRAP or android.util.Base64.NO_PADDING)
            prefs.edit().putString("device_token", token).apply()
        }
        return token
    }

    private fun deviceName(): String = (Build.MANUFACTURER + " " + Build.MODEL).trim().take(60)
    private fun platformName(): String = if (Build.MANUFACTURER.contains("amazon", true)) "fire-tv" else "android-tv"

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        intentionalStop = true
        handler.removeCallbacksAndMessages(null)
        try { unregisterReceiver(pairDecisionReceiver) } catch (_: Exception) {}
        try { unregisterReceiver(capabilityRefreshReceiver) } catch (_: Exception) {}
        socket?.close(1000, "Service stopped")
        socket = null
        client.dispatcher.executorService.shutdown()
        super.onDestroy()
    }
}
