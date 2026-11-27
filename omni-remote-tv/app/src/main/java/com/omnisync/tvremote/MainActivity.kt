package com.omnisync.tvremote

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

class MainActivity : Activity() {
    private lateinit var relayInput: EditText
    private lateinit var statusText: TextView
    private lateinit var codeText: TextView
    private lateinit var capabilityText: TextView

    private val events = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                TvConnectionService.ACTION_STATUS -> {
                    statusText.text = intent.getStringExtra("status") ?: "Waiting for relay"
                    intent.getStringExtra("code")?.let { codeText.text = it }
                    intent.getStringExtra("capability")?.let { capabilityText.text = it }
                }
                TvConnectionService.ACTION_PAIR_REQUEST -> {
                    val requestId = intent.getStringExtra("requestId") ?: return
                    val remoteName = intent.getStringExtra("remoteName") ?: "A phone"
                    AlertDialog.Builder(this@MainActivity)
                        .setTitle("Approve phone pairing?")
                        .setMessage("$remoteName wants permission to control this TV. Only approve devices you recognise.")
                        .setNegativeButton("Decline") { _, _ -> decidePairing(requestId, false) }
                        .setPositiveButton("Approve") { _, _ -> decidePairing(requestId, true) }
                        .setCancelable(false)
                        .show()
                }
            }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(8, 9, 13)
        window.navigationBarColor = Color.rgb(8, 9, 13)
        buildScreen()
        registerEvents()
        relayInput.setText(getPreferences(Context.MODE_PRIVATE).getString("relay_url", ""))
        requestNotificationPermissionIfNeeded()
        val saved = relayInput.text.toString().trim()
        if (saved.isNotEmpty()) startConnection(saved)
        statusText.text = if (saved.isEmpty()) "Enter your secure relay URL to begin" else "Starting TV connection…"
        refreshCapabilityText()
    }

    private fun buildScreen() {
        val scroll = ScrollView(this).apply { setBackgroundColor(Color.rgb(8, 9, 13)) }
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(20), dp(28), dp(20))
        }
        scroll.addView(root)
        setContentView(scroll)

        root.addView(text("OMNISYNC SYSTEMS  /  TV RECEIVER", 11, Color.rgb(255, 74, 91), true))
        root.addView(text("OMNI REMOTE TV", 29, Color.WHITE, true), margin(top = 8))
        root.addView(text("SECURE PHONE-TO-TV CONTROL", 11, Color.rgb(142, 149, 164), true), margin(top = 4))

        statusText = text("Not connected", 14, Color.rgb(98, 222, 165), true)
        root.addView(statusText, margin(top = 24))

        root.addView(text("PAIRING CODE", 10, Color.rgb(142, 149, 164), true), margin(top = 22))
        codeText = text("------", 38, Color.WHITE, true).apply {
            letterSpacing = 0.18f
            gravity = Gravity.START
        }
        root.addView(codeText, margin(top = 2))
        root.addView(text("Enter this code in the OmniRemote phone page. You must approve the phone on this TV.", 12, Color.rgb(157, 164, 177), false), margin(top = 5))

        root.addView(text("CLOUD RELAY ADDRESS (WSS)", 10, Color.rgb(142, 149, 164), true), margin(top = 22))
        relayInput = EditText(this).apply {
            setSingleLine(true)
            textSize = 14f
            setTextColor(Color.WHITE)
            setHintTextColor(Color.rgb(111, 118, 132))
            hint = "wss://your-relay-domain.example/ws"
            inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_VARIATION_URI
            imeOptions = EditorInfo.IME_ACTION_DONE
            setPadding(dp(14), dp(12), dp(14), dp(12))
            background = rounded(Color.rgb(23, 26, 36), Color.rgb(65, 70, 85), 10)
        }
        root.addView(relayInput, margin(top = 8))

        val connectButton = button("SAVE ADDRESS  /  CONNECT")
        connectButton.setOnClickListener {
            val url = relayInput.text.toString().trim()
            if (!url.startsWith("wss://") && !url.startsWith("ws://127.0.0.1") && !url.startsWith("ws://192.168.")) {
                statusText.text = "Use a secure wss:// relay URL for internet control"
                return@setOnClickListener
            }
            getPreferences(Context.MODE_PRIVATE).edit().putString("relay_url", url).apply()
            startConnection(url)
            statusText.text = "Connecting to cloud relay…"
        }
        root.addView(connectButton, margin(top = 10))

        val accessButton = button("ENABLE REMOTE INPUT")
        accessButton.setOnClickListener { startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
        root.addView(accessButton, margin(top = 10))

        capabilityText = text("", 11, Color.rgb(255, 198, 105), false)
        root.addView(capabilityText, margin(top = 18))

        root.addView(text("IMPORTANT", 10, Color.rgb(255, 74, 91), true), margin(top = 20))
        root.addView(text("Keep this TV app allowed to run in the background. Navigation input requires the OmniRemote accessibility service. Full D-pad support uses Android 13 / API 33 or newer. On older Fire OS builds, only the system actions supported by that device will work until an alternate input adapter is added.", 11, Color.rgb(153, 160, 173), false), margin(top = 6))
        root.addView(text("The relay only carries authenticated commands. It cannot turn a fully powered-off TV on; power control depends on the TV's own standby and network features.", 11, Color.rgb(118, 126, 141), false), margin(top = 12))
    }

    private fun refreshCapabilityText() {
        val enabled = isAccessibilityEnabled()
        val dpad = Build.VERSION.SDK_INT >= 33
        capabilityText.text = when {
            !enabled && dpad -> "Setup needed: enable OmniRemote TV under Accessibility. Your OS exposes D-pad actions."
            !enabled -> "Setup needed: enable OmniRemote TV under Accessibility. This OS is older than Android 13; D-pad support is device-dependent."
            dpad -> "Accessibility enabled. This OS version exposes system-wide D-pad actions."
            else -> "Accessibility enabled. Android " + Build.VERSION.RELEASE + " does not expose the newer system-wide D-pad actions."
        }
    }

    private fun isAccessibilityEnabled(): Boolean {
        val enabled = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val component = ComponentName(this, RemoteAccessibilityService::class.java).flattenToString()
        return enabled.split(':').any { it.equals(component, ignoreCase = true) }
    }

    private fun startConnection(url: String) {
        val intent = Intent(this, TvConnectionService::class.java).putExtra(TvConnectionService.EXTRA_RELAY_URL, url)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
    }

    private fun decidePairing(requestId: String, approved: Boolean) {
        sendBroadcast(Intent(TvConnectionService.ACTION_PAIR_DECISION)
            .setPackage(packageName)
            .putExtra("requestId", requestId)
            .putExtra("approved", approved))
    }

    @Suppress("DEPRECATION")
    private fun registerEvents() {
        val filter = IntentFilter().apply {
            addAction(TvConnectionService.ACTION_STATUS)
            addAction(TvConnectionService.ACTION_PAIR_REQUEST)
        }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(events, filter, Context.RECEIVER_NOT_EXPORTED)
        else registerReceiver(events, filter)
    }

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 71)
        }
    }

    override fun onResume() {
        super.onResume()
        if (::capabilityText.isInitialized) refreshCapabilityText()
    }

    override fun onDestroy() {
        try { unregisterReceiver(events) } catch (_: Exception) {}
        super.onDestroy()
    }

    private fun text(value: String, size: Int, color: Int, bold: Boolean): TextView =
        TextView(this).apply {
            text = value
            textSize = size.toFloat()
            setTextColor(color)
            if (bold) typeface = Typeface.DEFAULT_BOLD
            setLineSpacing(dp(3).toFloat(), 1f)
        }

    private fun button(label: String): Button = Button(this).apply {
        text = label
        textSize = 12f
        letterSpacing = 0.06f
        setTextColor(Color.WHITE)
        background = rounded(Color.rgb(174, 17, 39), Color.rgb(255, 73, 91), 10)
        isAllCaps = false
        minHeight = dp(48)
    }

    private fun rounded(fill: Int, stroke: Int, radius: Int) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        setStroke(dp(1), stroke)
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
    private fun margin(top: Int = 0): LinearLayout.LayoutParams =
        LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT).apply {
            topMargin = dp(top)
        }
}
