import { Notato, NotatoMask, type NotatoMode, notato, useNotato } from "@notato/react-native";
import { expoStorage } from "@notato/react-native/expo";
import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";

interface Product {
    id: string;
    name: string;
    price: number;
}

const PRODUCTS: Product[] = [
    { id: "maris", name: "Maris Piper", price: 1.2 },
    { id: "king", name: "King Edward", price: 1.45 },
    { id: "jersey", name: "Jersey Royal", price: 3.1 },
];

function ProductCard({ product, onAdd }: { product: Product; onAdd(): void }) {
    return (
        <View style={styles.card}>
            <Text style={styles.name}>{product.name}</Text>
            <Text style={styles.price}>£{product.price.toFixed(2)}</Text>
            <Pressable
                testID="add-to-basket"
                accessibilityRole="button"
                onPress={onAdd}
                style={styles.button}
            >
                <Text style={styles.buttonText}>Add to basket</Text>
            </Pressable>
        </View>
    );
}

function ProductList({ onAdd }: { onAdd(): void }) {
    return (
        <>
            {PRODUCTS.map((product) => (
                <ProductCard key={product.id} product={product} onAdd={onAdd} />
            ))}
        </>
    );
}

/** What masking does: the email is private, the search field is fine to record, the password never is. */
function Account() {
    const [search, setSearch] = useState("");
    const [password, setPassword] = useState("");
    return (
        <View style={styles.card}>
            <Text style={styles.name}>Your account</Text>
            <NotatoMask>
                <Text testID="email" style={styles.price}>
                    ada@example.com
                </Text>
            </NotatoMask>
            <NotatoMask private={false}>
                <TextInput
                    testID="search"
                    placeholder="Search potatoes"
                    value={search}
                    onChangeText={setSearch}
                    style={styles.input}
                />
            </NotatoMask>
            <TextInput
                testID="password"
                placeholder="Password"
                secureTextEntry
                value={password}
                onChangeText={setPassword}
                style={styles.input}
            />
        </View>
    );
}

/** The runtime API: on and off, the toolbar, and a note made from code. */
function Feedback() {
    const state = useNotato();
    const [result, setResult] = useState("");
    return (
        <View style={styles.card}>
            <Text style={styles.name}>Feedback</Text>
            <View style={styles.row}>
                <Text>Notato on</Text>
                <Switch
                    testID="notato-on"
                    value={state.enabled}
                    onValueChange={(on) => (on ? notato.enable() : notato.disable())}
                />
            </View>
            <View style={styles.row}>
                <Text>Toolbar</Text>
                <Switch
                    testID="notato-toolbar"
                    value={state.toolbarVisible}
                    onValueChange={(on) => (on ? notato.showToolbar() : notato.hideToolbar())}
                />
            </View>
            <Text style={styles.price}>
                {state.mode} mode · {state.connection} · {state.notes.length} notes,{" "}
                {state.pendingCount} not sent
            </Text>
            <Pressable
                testID="annotate-from-code"
                style={styles.button}
                onPress={() =>
                    notato
                        .annotate('ProductCard > Text:text("£1.45")', "Price checked from code", {
                            intent: "question",
                        })
                        .then((a) => setResult(`Made ${a.id.slice(-6)}`))
                        .catch((e: Error) => setResult(e.message))
                }
            >
                <Text style={styles.buttonText}>Annotate the price from code</Text>
            </Pressable>
            {result ? <Text style={styles.price}>{result}</Text> : null}
        </View>
    );
}

function Shop() {
    const [count, setCount] = useState(0);
    return (
        <View style={styles.screen}>
            <View style={styles.header}>
                <Text style={styles.title}>Spud Shop</Text>
                <Text testID="basket" style={styles.basket}>
                    {count} in the basket
                </Text>
            </View>
            <ScrollView contentContainerStyle={styles.list} keyboardShouldPersistTaps="handled">
                <ProductList onAdd={() => setCount((n) => n + 1)} />
                <Account />
                <Feedback />
            </ScrollView>
            <StatusBar style="dark" />
        </View>
    );
}

export default function App() {
    return (
        // Another server than the one on 4747, and another mode:
        // EXPO_PUBLIC_NOTATO_SERVER=http://localhost:4799 EXPO_PUBLIC_NOTATO_MODE=test npx expo start
        <Notato
            project="react-native-example"
            appName="Spud Shop"
            appVersion="1.0.0"
            mode={(process.env.EXPO_PUBLIC_NOTATO_MODE as NotatoMode | undefined) ?? "dev"}
            server={process.env.EXPO_PUBLIC_NOTATO_SERVER}
            storage={expoStorage}
            route="/shop"
        >
            <Shop />
        </Notato>
    );
}

const styles = StyleSheet.create({
    screen: { flex: 1, backgroundColor: "#fff" },
    header: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "baseline",
        paddingHorizontal: 20,
        paddingTop: 56,
        paddingBottom: 12,
    },
    title: { fontSize: 26, fontWeight: "700" },
    basket: { color: "#555" },
    list: { padding: 20, gap: 16, paddingBottom: 140 },
    card: { borderWidth: 1, borderColor: "#ddd", borderRadius: 12, padding: 16, gap: 4 },
    name: { fontSize: 18, fontWeight: "600" },
    price: { color: "#555", marginTop: 4 },
    row: {
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        marginTop: 6,
    },
    input: {
        borderWidth: 1,
        borderColor: "#ddd",
        borderRadius: 8,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginTop: 8,
    },
    button: {
        marginTop: 12,
        alignSelf: "flex-start",
        backgroundColor: "#2f6f4f",
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderRadius: 8,
    },
    buttonText: { color: "#fff", fontWeight: "600" },
});
