package dev.notato.android.compose

import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics

/**
 * What [notatoMask] sets: true (private) or false (not private). Not important for accessibility, as `TestTag` is
 * not, so TalkBack reads nothing new; Notato reads it from the unmerged tree.
 */
internal val NotatoMaskKey: SemanticsPropertyKey<Boolean> = SemanticsPropertyKey("NotatoMask")

/**
 * Marks how private a composable is, for screenshots and for everything a note records, as `Notato.mask` does for a
 * View:
 *
 * - `true` (the default): private (card numbers, personal details). Covered in screenshots, and neither its text nor
 *   that of anything inside it is recorded: no text, label or content description, no `:text(…)` in selectors, nothing
 *   in the text of what it sits in. Everything inside it is private too.
 * - `false`: not private. A text field (a search box) is shown, and its value recorded, even when `maskInputs` is on;
 *   on a container, the fields in it are. A private composable around it still wins, and password fields are masked
 *   regardless.
 *
 * It only adds a semantics property, as `testTag` does: it merges nothing and TalkBack reads the same.
 */
public fun Modifier.notatoMask(masked: Boolean = true): Modifier = this.semantics { this[NotatoMaskKey] = masked }
