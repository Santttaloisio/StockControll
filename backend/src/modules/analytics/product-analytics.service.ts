import { QueryTypes } from 'sequelize';
import { sequelize } from '../../database/sequelize.js';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const allowedMonthRanges = new Set([6, 12, 24]);

export class ProductAnalyticsError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string
  ) {
    super(message);
    this.name = 'ProductAnalyticsError';
  }
}

interface ProductSalesRow {
  product_id: string;
  product_name: string;
  units_sold: string;
  recent_units: string;
  previous_units: string;
}

interface ProductVariantSalesRow {
  product_id: string;
  variant_id: string;
  sku: string | null;
  size: string | null;
  color: string | null;
  units_sold: string;
}

interface MonthlySalesRow {
  product_id: string;
  month: string;
  units_sold: string;
}

function subtractMonths(date: Date, count: number): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - count, 1));
}

export async function getProductSalesAnalytics(storeId: string, months: number): Promise<{
  months: number;
  startDate: string;
  endDate: string;
  products: {
    productId: string;
    name: string;
    unitsSold: number;
    trend: 'rising' | 'falling' | 'stable';
    changePercent: number | null;
    variants: {
      variantId: string;
      sku: string | null;
      size: string | null;
      color: string | null;
      unitsSold: number;
    }[];
    monthlySales: { month: string; unitsSold: number }[];
  }[];
}> {
  if (!uuidPattern.test(storeId)) {
    throw new ProductAnalyticsError('Store ID must be a valid UUID.', 400, 'INVALID_INPUT');
  }
  if (!allowedMonthRanges.has(months)) {
    throw new ProductAnalyticsError('Months must be 6, 12, or 24.', 400, 'INVALID_INPUT');
  }

  const now = new Date();
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const startDate = subtractMonths(currentMonthStart, months - 1);
  const endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  const recentWindowStart = subtractMonths(currentMonthStart, 3);
  const previousWindowStart = subtractMonths(currentMonthStart, 6);
  const replacements = {
    storeId,
    startDate,
    endDate,
    queryStartDate: startDate < previousWindowStart ? startDate : previousWindowStart,
    recentWindowStart,
    currentMonthStart,
    previousWindowStart
  };

  const salesRows = await sequelize.query<ProductSalesRow>(
    `WITH paid_sales AS (
       SELECT
         p.id AS product_id,
         p.name AS product_name,
         v.id AS variant_id,
         l.quantity,
         COALESCE(o.paid_at_provider, o.created_at_provider) AS sold_at
       FROM tiendanube_orders o
       JOIN tiendanube_order_lines l
         ON l.store_id = o.store_id AND l.order_id = o.id
       JOIN product_variants v
         ON v.store_id = l.store_id AND v.id = l.product_variant_id
       JOIN products p
         ON p.store_id = v.store_id AND p.id = v.product_id
       WHERE o.store_id = :storeId
         AND o.payment_status = 'paid'
         AND o.is_cancelled = FALSE
         AND COALESCE(o.paid_at_provider, o.created_at_provider) IS NOT NULL
     )
     SELECT
       product_id,
       product_name,
       SUM(CASE WHEN sold_at >= :startDate THEN quantity ELSE 0 END)::TEXT AS units_sold,
       SUM(CASE WHEN sold_at >= :recentWindowStart AND sold_at < :currentMonthStart
         THEN quantity ELSE 0 END)::TEXT AS recent_units,
       SUM(CASE WHEN sold_at >= :previousWindowStart AND sold_at < :recentWindowStart
         THEN quantity ELSE 0 END)::TEXT AS previous_units
     FROM paid_sales
     WHERE sold_at >= :queryStartDate AND sold_at < :endDate
     GROUP BY product_id, product_name
     HAVING SUM(CASE WHEN sold_at >= :startDate THEN quantity ELSE 0 END) > 0
     ORDER BY SUM(CASE WHEN sold_at >= :startDate AND sold_at < :endDate
       THEN quantity ELSE 0 END) DESC, product_name ASC
     LIMIT 10`,
    { replacements, type: QueryTypes.SELECT }
  );

  const productIds = salesRows.map((row) => row.product_id);
  const variantRows = productIds.length > 0
    ? await sequelize.query<ProductVariantSalesRow>(
      `SELECT
         p.id AS product_id,
         v.id AS variant_id,
         v.sku,
         v.size,
         v.color,
         SUM(l.quantity)::TEXT AS units_sold
       FROM tiendanube_orders o
       JOIN tiendanube_order_lines l
         ON l.store_id = o.store_id AND l.order_id = o.id
       JOIN product_variants v
         ON v.store_id = l.store_id AND v.id = l.product_variant_id
       JOIN products p
         ON p.store_id = v.store_id AND p.id = v.product_id
       WHERE o.store_id = :storeId
         AND o.payment_status = 'paid'
         AND o.is_cancelled = FALSE
         AND COALESCE(o.paid_at_provider, o.created_at_provider) >= :startDate
         AND COALESCE(o.paid_at_provider, o.created_at_provider) < :endDate
         AND p.id IN (:productIds)
       GROUP BY p.id, v.id, v.sku, v.size, v.color
       ORDER BY p.id, SUM(l.quantity) DESC, v.sku ASC NULLS LAST`,
      { replacements: { ...replacements, productIds }, type: QueryTypes.SELECT }
    )
    : [];
  const variantsByProduct = new Map<string, ProductVariantSalesRow[]>();
  for (const row of variantRows) {
    const variants = variantsByProduct.get(row.product_id) ?? [];
    variants.push(row);
    variantsByProduct.set(row.product_id, variants);
  }

  const monthlyRows = productIds.length > 0
    ? await sequelize.query<MonthlySalesRow>(
      `SELECT
         p.id AS product_id,
         TO_CHAR(DATE_TRUNC('month', COALESCE(o.paid_at_provider, o.created_at_provider)), 'YYYY-MM') AS month,
         SUM(l.quantity)::TEXT AS units_sold
       FROM tiendanube_orders o
       JOIN tiendanube_order_lines l
         ON l.store_id = o.store_id AND l.order_id = o.id
       JOIN product_variants v
         ON v.store_id = l.store_id AND v.id = l.product_variant_id
       JOIN products p
         ON p.store_id = v.store_id AND p.id = v.product_id
       WHERE o.store_id = :storeId
         AND o.payment_status = 'paid'
         AND o.is_cancelled = FALSE
         AND COALESCE(o.paid_at_provider, o.created_at_provider) >= :startDate
         AND COALESCE(o.paid_at_provider, o.created_at_provider) < :endDate
         AND p.id IN (:productIds)
       GROUP BY p.id, DATE_TRUNC('month', COALESCE(o.paid_at_provider, o.created_at_provider))
       ORDER BY p.id, DATE_TRUNC('month', COALESCE(o.paid_at_provider, o.created_at_provider))`,
      { replacements: { ...replacements, productIds }, type: QueryTypes.SELECT }
    )
    : [];
  const monthlySalesByProduct = new Map(
    monthlyRows.map((row) => [`${row.product_id}:${row.month}`, Number(row.units_sold)])
  );
  const monthKeys = Array.from({ length: months }, (_unused, index) => {
    const monthStart = new Date(Date.UTC(
      startDate.getUTCFullYear(),
      startDate.getUTCMonth() + index,
      1
    ));
    return monthStart.toISOString().slice(0, 7);
  });

  const products = salesRows.map((row) => {
    const recentUnits = Number(row.recent_units);
    const previousUnits = Number(row.previous_units);
    const unitsSold = Number(row.units_sold);
    const changePercent = previousUnits > 0
      ? Math.round(((recentUnits - previousUnits) / previousUnits) * 100)
      : null;
    const trend = previousUnits === 0
      ? recentUnits > 0 ? 'rising' as const : unitsSold === 0 ? 'stable' as const : 'falling' as const
      : recentUnits >= previousUnits * 1.1
        ? 'rising' as const
        : recentUnits <= previousUnits * 0.9
          ? 'falling' as const
          : 'stable' as const;

    return {
      productId: row.product_id,
      name: row.product_name,
      unitsSold,
      trend,
      changePercent,
      variants: (variantsByProduct.get(row.product_id) ?? []).map((variant) => ({
        variantId: variant.variant_id,
        sku: variant.sku,
        size: variant.size,
        color: variant.color,
        unitsSold: Number(variant.units_sold)
      })),
      monthlySales: monthKeys.map((month) => ({
        month,
        unitsSold: monthlySalesByProduct.get(`${row.product_id}:${month}`) ?? 0
      }))
    };
  });

  return {
    months,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: new Date(endDate.getTime() - 1).toISOString().slice(0, 10),
    products
  };
}
