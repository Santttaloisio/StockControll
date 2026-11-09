# StockControll frontend

The React/Vite dashboard provides sign-in, store selection, a product and inventory view, and an owner/admin action to import the connected Tiendanube catalog.

## Run locally

Start PostgreSQL and the backend from the repository root:

```powershell
docker compose up -d
npm run dev --prefix backend
```

In another terminal, start the frontend:

```powershell
npm run dev --prefix frontend
```

Open the local URL printed by Vite (usually `http://localhost:5173`). Vite proxies `/api` requests to the backend at `http://localhost:3000`.

The dashboard access token is kept in `sessionStorage` for the current browser tab. Importing the catalog reads from Tiendanube and stores products, variants, and initial stock in the selected StockControll store; it does not write stock changes back to Tiendanube. After the complete catalog import, the backend enables order webhooks: new orders update internal stock, cancellations reverse the movement, and payment status is recorded for later sales statistics.

The main navigation separates **Productos**, **Movimientos**, and **Estadísticas** into independent views; only the selected view is displayed. The product catalog shows the first Tiendanube product photo when available; re-import the catalog to refresh product photos. The **Estadísticas** view has three tabs: **Más vendidos** ranks products and shows sales by variant, **Estacionalidad** charts monthly sales for one selected product, and **Tendencias** compares product demand over two periods. Trends compare the last three complete months with the three before them. Only paid, non-cancelled orders count. Owners/admins can import historical orders from this section; that import does not alter inventory.
