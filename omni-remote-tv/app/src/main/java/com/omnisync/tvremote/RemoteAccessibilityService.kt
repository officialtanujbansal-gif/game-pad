package com.omnisync.tvremote

import android.accessibilityservice.AccessibilityService
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.os.Build
import android.view.accessibility.AccessibilityEvent

data class ActionResult(val success: Boolean, val reason: String = "")

class RemoteAccessibilityService : AccessibilityService() {
    companion object {
        @Volatile private var active: RemoteAccessibilityService? = null

        fun isActive(): Boolean = active != null

        fun execute(context: Context, action: String): ActionResult {
            val service = active
            return when (action) {
                "volume_up" -> adjustVolume(context, AudioManager.ADJUST_RAISE)
                "volume_down" -> adjustVolume(context, AudioManager.ADJUST_LOWER)
                "mute" -> {
                    if (Build.VERSION.SDK_INT >= 23) adjustVolume(context, AudioManager.ADJUST_TOGGLE_MUTE)
                    else ActionResult(false, "mute_not_supported")
                }
                "up" -> dpad(service, AccessibilityService.GLOBAL_ACTION_DPAD_UP)
                "down" -> dpad(service, AccessibilityService.GLOBAL_ACTION_DPAD_DOWN)
                "left" -> dpad(service, AccessibilityService.GLOBAL_ACTION_DPAD_LEFT)
                "right" -> dpad(service, AccessibilityService.GLOBAL_ACTION_DPAD_RIGHT)
                "select" -> dpad(service, AccessibilityService.GLOBAL_ACTION_DPAD_CENTER)
                "back" -> global(service, AccessibilityService.GLOBAL_ACTION_BACK)
                "home" -> global(service, AccessibilityService.GLOBAL_ACTION_HOME)
                "power_menu" -> global(service, AccessibilityService.GLOBAL_ACTION_POWER_DIALOG)
                else -> ActionResult(false, "unsupported_action")
            }
        }

        private fun dpad(service: RemoteAccessibilityService?, action: Int): ActionResult {
            if (Build.VERSION.SDK_INT < 33) return ActionResult(false, "dpad_requires_android_13")
            return global(service, action)
        }

        private fun global(service: RemoteAccessibilityService?, action: Int): ActionResult {
            if (service == null) return ActionResult(false, "accessibility_service_disabled")
            return if (service.performGlobalAction(action)) ActionResult(true) else ActionResult(false, "system_action_rejected")
        }

        private fun adjustVolume(context: Context, direction: Int): ActionResult {
            return try {
                val audio = context.getSystemService(Context.AUDIO_SERVICE) as AudioManager
                audio.adjustStreamVolume(AudioManager.STREAM_MUSIC, direction, 0)
                ActionResult(true)
            } catch (_: Exception) {
                ActionResult(false, "volume_not_supported")
            }
        }
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        active = this
        sendBroadcast(Intent(TvConnectionService.ACTION_REFRESH_CAPABILITIES).setPackage(packageName))
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) = Unit
    override fun onInterrupt() = Unit

    override fun onDestroy() {
        if (active === this) active = null
        sendBroadcast(Intent(TvConnectionService.ACTION_REFRESH_CAPABILITIES).setPackage(packageName))
        super.onDestroy()
    }
}
