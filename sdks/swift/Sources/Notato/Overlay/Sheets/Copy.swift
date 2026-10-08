/// The words every Notato SDK uses for keeping things from the agent.
enum PeopleOnlyCopy {
    static let title = "People only"
    static let hint = "Keep this between people: the agent won't see it."
    static let aside = "Aside"
    static let asideHint = "Just for people: the agent won't see this reply."
}

/// What a note's card says where every SDK says the same.
enum CardCopy {
    /// A note's card with no server to send it to (test mode): where the note is, and how it leaves.
    static let keptHere = "Kept on this device. Package it from the menu to share it."
}
