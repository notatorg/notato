import { Component, output } from "@angular/core";
import { type Product, ProductCard } from "./product-card";

@Component({
    selector: "product-list",
    imports: [ProductCard],
    template: `
        <section class="grid">
            @for (product of products; track product.id) {
                <product-card [product]="product" (add)="added.emit($event)" />
            }
        </section>
    `,
    styles: `.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 16px; }`,
})
export class ProductList {
    readonly added = output<Product>();
    protected readonly products: Product[] = [
        { id: "maris", name: "Maris Piper", price: 1.2 },
        { id: "king", name: "King Edward", price: 1.45 },
        { id: "jersey", name: "Jersey Royal", price: 3.1 },
    ];
}
