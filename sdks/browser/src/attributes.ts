/** The toolbar, pins and popover live under an element carrying this attribute, and are never recorded or captured. */
export const ROOT_ATTR = "data-notato-root";

/**
 * Marks an element private: its text is never recorded, and screenshots show a solid block in its place, in every mode.
 * `data-notato-mask="false"` instead opts a field out of the masking `maskInputs` turns on.
 */
export const MASK_ATTR = "data-notato-mask";

/**
 * Regions people type into that are not form fields: rich-text editors, chat boxes. What is in them is the person's
 * own writing, as a textarea's value is, and is kept out of notes and screenshots the same way.
 */
export const EDITABLE =
    '[contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="searchbox"]';
