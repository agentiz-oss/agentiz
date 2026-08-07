package com.example.app

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import com.example.app.data.initLocalCache
import com.example.app.data.initSessionStorage
import com.example.app.platform.initHaptics

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Before the first composition: App() reads the stored session as it starts up.
        initSessionStorage(this)
        initLocalCache(this)
        initHaptics(this)
        setContent {
            App()
        }
    }
}
