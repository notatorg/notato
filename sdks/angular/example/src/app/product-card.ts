import { Component, input, output } from "@angular/core";

export interface Product {
    id: string;
    name: string;
    price: number;
}

@Component({
    selector: "product-card",
    template: `
        <article class="card">
            <h3>{{ product().name }}</h3>
            <p class="price">£{{ product().price.toFixed(2) }}</p>
            <button type="button" data-testid="add-to-basket" (click)="add.emit(product())">Add to basket</button>
        </article>
    `,
    styles: `
        .card { border: 1px solid #ddd; border-radius: 12px; padding: 16px; }
        .price { color: #555; }
        button { padding: 8px 14px; border-radius: 8px; border: 0; background: #2f6f4f; color: white; }
    `,
})
export class ProductCard {
    readonly product = input.required<Product>();
    readonly add = output<Product>();
}
