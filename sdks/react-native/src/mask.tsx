import type { ReactNode } from "react";

export interface NotatoMaskProps {
    /**
     * `true` (default): what is inside is private. It is covered in screenshots and none of its text is recorded, not
     * as its text or label and not in its selector, and a selector cannot find it by its text. `false`: the text fields
     * inside are recorded even when `maskInputs` is on. Password fields stay masked either way, and a private mark
     * around a `false` one wins.
     */
    private?: boolean;
    children?: ReactNode;
}

/**
 * Marks what is inside as private to Notato, or (`private={false}`) its text fields as fine to record. It renders its
 * children and nothing else, in every build. The web SDK's `data-notato-mask`.
 *
 * ```tsx
 * <NotatoMask><Text>{user.email}</Text></NotatoMask>
 * <NotatoMask private={false}><TextInput placeholder="Search" /></NotatoMask>
 * ```
 */
export function NotatoMask(props: NotatoMaskProps) {
    return <>{props.children}</>;
}
