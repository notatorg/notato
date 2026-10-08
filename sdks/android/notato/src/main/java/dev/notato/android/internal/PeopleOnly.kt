package dev.notato.android.internal

import dev.notato.android.model.Annotation
import dev.notato.android.model.Author
import dev.notato.android.model.Reply

/**
 * People only, worked out here for a note the server does not have yet (test mode, or one made while it was down),
 * exactly as the server does it for one it has (packages/server/src/backend.ts), so a package carries the history.
 */
internal object PeopleOnly {
    /** What the server writes in the thread when People only is turned on, and off: the same words here. */
    const val ON_TEXT: String = "Made this people only: the agent won't see it."
    const val OFF_TEXT: String = "Shared this with the agent."

    /**
     * [annotation] with People only turned [on] by [author]: the flag set (left out when off), and an automatic entry
     * at the end of the thread that records the change. Returned as it is when it is that way already.
     */
    fun toggle(annotation: Annotation, on: Boolean, author: Author, id: String = Ulid.make(), at: String = Time.iso()): Annotation {
        if ((annotation.peopleOnly == true) == on) return annotation
        require(author.kind == "human") { "Only a person can turn People only on or off." }
        val entry = Reply(id, author, if (on) ON_TEXT else OFF_TEXT, at, automatic = true, peopleOnly = on)
        return annotation.copy(peopleOnly = on.takeIf { it }, thread = annotation.thread + entry)
    }

    /**
     * Once the server has a note that waited here: whether it must still be told to turn People only on (`true`) or
     * off (`false`), or nothing (null). Only when it was [changedHere] while the note waited, and the server's copy
     * ([server]) says otherwise than this one ([local]): the change came while the note was on its way.
     */
    fun stillToSend(changedHere: Boolean, local: Annotation, server: Annotation): Boolean? {
        if (!changedHere) return null
        val wanted = local.peopleOnly == true
        return wanted.takeIf { (server.peopleOnly == true) != it }
    }
}
