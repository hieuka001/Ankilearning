// Copyright 2026 AnkiLearning contributors
// SPDX-License-Identifier: MIT

package com.ankilearning.apkinstaller

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

@InvokeArg
class InstallApkArgs {
    lateinit var path: String
}

/**
 * Opens the system package installer for an APK file the app itself
 * downloaded (the shell's self-update flow). The file is shared through
 * the FileProvider the generated app already declares
 * ("<applicationId>.fileprovider", whose file_paths cover the cache
 * directory), and the intent carries the package-archive MIME type plus
 * a read grant — the two things a bare ACTION_VIEW cannot express.
 */
@TauriPlugin
class ApkInstallerPlugin(private val activity: Activity) : Plugin(activity) {

    @Command
    fun installApk(invoke: Invoke) {
        try {
            val args = invoke.parseArgs(InstallApkArgs::class.java)
            val file = File(args.path)
            if (!file.isFile) {
                invoke.reject("APK file not found: ${args.path}")
                return
            }
            val authority = activity.packageName + ".fileprovider"
            val uri: Uri = FileProvider.getUriForFile(activity, authority, file)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            activity.startActivity(intent)
            val result = JSObject()
            result.put("opened", true)
            invoke.resolve(result)
        } catch (ex: Exception) {
            invoke.reject(ex.message ?: "Failed to open the APK installer")
        }
    }
}
