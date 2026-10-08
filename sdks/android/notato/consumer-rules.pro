# Notato's wire model is read and written with kotlinx.serialization.
-keepclassmembers class dev.notato.android.model.** { *** Companion; }
-keepclasseswithmembers class dev.notato.android.model.** { kotlinx.serialization.KSerializer serializer(...); }

# Nothing else is reached by reflection: Fragments are found through the tag AndroidX Fragment puts on each Fragment's
# view (its id looked up by name), and the app's windows through WindowInspector (Android 10 and later) or the
# platform's own window list.
