package dev.notato.sample

import android.os.Bundle
import android.view.View
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.fragment.app.Fragment

/** A classic View screen: an AppCompat activity hosting its form as a Fragment, laid out in XML. */
class AccountActivity : AppCompatActivity(R.layout.activity_account) {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        supportActionBar?.setDisplayHomeAsUpEnabled(true)
    }

    override fun onSupportNavigateUp(): Boolean {
        finish()
        return true
    }
}

class AccountFragment : Fragment(R.layout.fragment_account) {
    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        // The email address is private: covered in screenshots and never recorded, even in dev mode where other fields
        // are. The password field is masked anyway. Notato.mask(searchField, false) would do the opposite for a field
        // that is fine to record when maskInputs is on. (notatoPrivate is Notato.mask in debug builds, nothing in release.)
        notatoPrivate(view.findViewById(R.id.email))
        view.findViewById<View>(R.id.save).setOnClickListener {
            Toast.makeText(requireContext(), R.string.saved, Toast.LENGTH_SHORT).show()
        }
        view.findViewById<View>(R.id.sign_out).setOnClickListener { requireActivity().finish() }
    }
}
