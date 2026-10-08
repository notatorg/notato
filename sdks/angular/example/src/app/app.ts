import { Component, signal } from "@angular/core";
import type { Product } from "./product-card";
import { ProductList } from "./product-list";

@Component({
    selector: "app-root",
    imports: [ProductList],
    template: `
        <header>
            <h1>Spud Shop</h1>
            <p class="basket" data-testid="basket">{{ count() }} in the basket</p>
        </header>
        <product-list (added)="add($event)" />
    `,
    styles: `
        :host { display: block; max-width: 720px; margin: 32px auto; font-family: system-ui, sans-serif; }
        header { display: flex; justify-content: space-between; align-items: baseline; }
    `,
})
export class App {
    protected readonly count = signal(0);

    protected add(_product: Product) {
        this.count.update((n) => n + 1);
    }
}
