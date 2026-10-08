// Notes kept between launches, and packages shared from the share sheet, with Expo's modules: in every Expo app, and
// in a bare app that has added Expo modules (`npx install-expo-modules`).
//
//     import { expoStorage } from "@notato/react-native/expo";
//     <Notato project="shop" storage={expoStorage}>…</Notato>
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { type ExpoFs, fileStorage, type StorageProvider } from "./storage.ts";

/** Notato's storage and sharing with expo-file-system and expo-sharing: pass it to `<Notato storage={…}>`. */
export const expoStorage: StorageProvider = {
    open: (project) => fileStorage(project, { File, Directory, Paths } as ExpoFs),
    async share(uri) {
        try {
            if (!(await Sharing.isAvailableAsync())) return false;
            await Sharing.shareAsync(uri, {
                mimeType: "application/zip",
                dialogTitle: "Notato notes",
            });
            return true;
        } catch {
            return false;
        }
    },
};
