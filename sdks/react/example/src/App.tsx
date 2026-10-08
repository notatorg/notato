import { type MouseEvent, useEffect, useState } from "react";

const PRODUCTS = [
    { id: "mug", name: "Enamel mug", price: 14 },
    { id: "tote", name: "Canvas tote", price: 22 },
    { id: "notebook", name: "Dot-grid notebook", price: 9 },
];

function useRoute() {
    const [path, setPath] = useState(window.location.pathname);
    useEffect(() => {
        const onPop = () => setPath(window.location.pathname);
        window.addEventListener("popstate", onPop);
        return () => window.removeEventListener("popstate", onPop);
    }, []);
    const go = (to: string) => {
        window.history.pushState({}, "", to);
        setPath(to);
    };
    return { path, go };
}

function Header({ path, go }: { path: string; go: (to: string) => void }) {
    const link = (to: string) => (e: MouseEvent<HTMLAnchorElement>) => {
        e.preventDefault();
        go(to);
    };
    return (
        <header className="header">
            <strong>Corner Shop</strong>
            <nav aria-label="Main">
                <a href="/" className={path === "/" ? "active" : ""} onClick={link("/")}>
                    Checkout
                </a>
                <a
                    href="/orders"
                    data-testid="nav-orders"
                    className={path === "/orders" ? "active" : ""}
                    onClick={link("/orders")}
                >
                    Orders
                </a>
            </nav>
        </header>
    );
}

function Checkout() {
    const [cart, setCart] = useState<Record<string, number>>({ mug: 1 });
    const [paid, setPaid] = useState(false);
    const total = PRODUCTS.reduce((sum, p) => sum + p.price * (cart[p.id] ?? 0), 0);

    return (
        <main className="page">
            <h1>Checkout</h1>
            <section aria-labelledby="items-h">
                <h2 id="items-h">Your items</h2>
                <ul className="products">
                    {PRODUCTS.map((p) => (
                        <li key={p.id} className="product">
                            <span className="name">{p.name}</span>
                            <span className="price">${p.price}</span>
                            <button
                                type="button"
                                className="secondary"
                                onClick={() =>
                                    setCart((c) => ({ ...c, [p.id]: (c[p.id] ?? 0) + 1 }))
                                }
                            >
                                Add
                            </button>
                            <span className="qty">×{cart[p.id] ?? 0}</span>
                        </li>
                    ))}
                </ul>
            </section>

            <section aria-labelledby="pay-h" className="payment">
                <h2 id="pay-h">Payment</h2>
                <form
                    onSubmit={(e) => {
                        e.preventDefault();
                        setPaid(true);
                        console.log("order placed", { total });
                        fetch("/api/orders?token=secret-should-not-be-recorded", {
                            method: "POST",
                            body: "{}",
                        }).catch(() => {});
                    }}
                >
                    <label>
                        Full name
                        <input name="name" autoComplete="off" defaultValue="Ada Lovelace" />
                    </label>
                    <label>
                        Email
                        <input
                            name="email"
                            type="email"
                            autoComplete="off"
                            defaultValue="ada@example.com"
                        />
                    </label>
                    <label>
                        Card number
                        <input
                            name="card"
                            autoComplete="off"
                            defaultValue="4242 4242 4242 4242"
                            data-notato-mask
                        />
                    </label>
                    <label>
                        Delivery notes
                        <textarea
                            name="notes"
                            defaultValue="Leave with the neighbour at number 9."
                        />
                    </label>
                    <button type="submit" id="pay" data-testid="pay-button" className="primary">
                        Pay now — ${total}
                    </button>
                </form>
                {paid && (
                    <p role="status" className="success">
                        Thanks! Your order is on its way.
                    </p>
                )}
            </section>

            <p className="spacer">
                The page is deliberately tall so scrolling, fixed banners and off-screen targets can
                be tested.
            </p>
            <div className="tall" />
            <footer className="footer">
                <button
                    type="button"
                    className="secondary"
                    id="back-to-top"
                    onClick={() => window.scrollTo({ top: 0 })}
                >
                    Back to top
                </button>
            </footer>
        </main>
    );
}

function Orders() {
    return (
        <main className="page">
            <h1>Orders</h1>
            <p>You have no orders yet.</p>
        </main>
    );
}

export function App() {
    const { path, go } = useRoute();
    return (
        <>
            <Header path={path} go={go} />
            {path === "/orders" ? <Orders /> : <Checkout />}
            <aside className="cookie" aria-label="Cookie notice">
                We use cookies to remember your cart.
                <button type="button" className="secondary">
                    Got it
                </button>
            </aside>
        </>
    );
}
