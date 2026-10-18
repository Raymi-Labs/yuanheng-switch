package com.nanashiwang.yuanheng.nativebridge

import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.provider.MediaStore
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg class SessionArgs { lateinit var value: String }
@InvokeArg class ImageArgs { lateinit var data: String; lateinit var mime: String }

@TauriPlugin
class YuanhengPlugin(private val activity: Activity): Plugin(activity) {
    private val alias = "yuanheng-mobile-session-v1"
    private val prefs get() = activity.getSharedPreferences("yuanheng-session", Context.MODE_PRIVATE)
    private fun secret(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    @Command fun readSession(invoke: Invoke) {
        try {
            val stored = prefs.getString("session", null)
            val value = stored?.let {
                val bytes = Base64.decode(it, Base64.NO_WRAP)
                require(bytes.size > 28)
                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                cipher.init(Cipher.DECRYPT_MODE, secret(), GCMParameterSpec(128, bytes.copyOfRange(0,12)))
                String(cipher.doFinal(bytes.copyOfRange(12,bytes.size)), Charsets.UTF_8)
            }
            val result = JSObject()
            result.put("value", value ?: org.json.JSONObject.NULL)
            invoke.resolve(result)
        } catch (_: Exception) { invoke.reject("无法读取安全存储，请清除登录状态后重试") }
    }
    @Command fun writeSession(invoke: Invoke) {
        try {
            val value = invoke.parseArgs(SessionArgs::class.java).value
            require(value.length <= 16384)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secret())
            val encrypted = cipher.iv + cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            check(prefs.edit().putString("session", Base64.encodeToString(encrypted, Base64.NO_WRAP)).commit())
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("无法保存登录状态") }
    }
    @Command fun clearSession(invoke: Invoke) {
        if (prefs.edit().remove("session").commit()) invoke.resolve() else invoke.reject("无法清除登录状态")
    }
    @Command fun saveImage(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(ImageArgs::class.java)
            require(args.mime in listOf("image/png", "image/jpeg", "image/webp"))
            val bytes = Base64.decode(args.data, Base64.NO_WRAP)
            require(bytes.isNotEmpty() && bytes.size <= 32 * 1024 * 1024)
            val ext = when(args.mime) { "image/jpeg" -> "jpg"; "image/webp" -> "webp"; else -> "png" }
            val values = ContentValues().apply {
                put(MediaStore.Images.Media.DISPLAY_NAME, "元衡-${System.currentTimeMillis()}.$ext")
                put(MediaStore.Images.Media.MIME_TYPE, args.mime)
                put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/YuanHeng")
                put(MediaStore.Images.Media.IS_PENDING, 1)
            }
            val resolver = activity.contentResolver
            val uri = resolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values) ?: error("insert")
            try {
                resolver.openOutputStream(uri)?.use { it.write(bytes) } ?: error("write")
                values.clear(); values.put(MediaStore.Images.Media.IS_PENDING, 0)
                check(resolver.update(uri, values, null, null) == 1)
            } catch (error: Exception) { resolver.delete(uri, null, null); throw error }
            invoke.resolve()
        } catch (_: Exception) { invoke.reject("图片保存失败，请重试") }
    }
}
