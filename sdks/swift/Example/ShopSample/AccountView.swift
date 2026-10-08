import SwiftUI
import OSLog
import Notato

struct AccountView: View {
    private let logger = Logger(subsystem: "com.notato.swiftsample", category: "Account")
    @State private var email = ""
    @State private var password = ""
    @State private var remember = true

    var body: some View {
        Form {
            Section {
                TextField("you@example.com", text: $email)
                    .keyboardType(.emailAddress).textInputAutocapitalization(.never)
                    .accessibilityIdentifier("Email")
                SecureField("At least 8 characters", text: $password).accessibilityIdentifier("Password")
                Toggle("Keep me signed in", isOn: $remember)
            }
            Section {
                Button("Sign in") {
                    // Something for Notato's log capture to attach to a note about this button. What was typed stays
                    // out of the log, as it would in a real app.
                    logger.error("Sign in failed: the demo has no accounts")
                }
                .accessibilityIdentifier("SignIn")
                Text("Forgot your password?").font(.footnote).foregroundStyle(.blue)
            }
        }
        .navigationTitle("Account")
        .notatoScreen()
    }
}
