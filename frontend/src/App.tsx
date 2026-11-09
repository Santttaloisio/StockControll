import { useEffect, useMemo, useState, type FormEvent } from 'react'
import './App.css'

type StoreSummary = {
  id: string
  name: string
  role: 'owner' | 'admin' | 'manager' | 'staff'
}

type CatalogProduct = {
  id: string
  name: string
  tiendanubeProductId: string | null
  imageUrl: string | null
  variants: {
    id: string
    sku: string | null
    size: string | null
    color: string | null
    quantity: number
  }[]
}

type InventoryLocation = {
  id: string
  name: string
  type: 'store' | 'warehouse' | 'other'
}

type MovementRecord = {
  id: string
  type: 'entry' | 'exit' | 'adjustment' | 'transfer' | 'return'
  quantity: number
  createdAt: string
  reference: string | null
  notes: string | null
  productName: string
  sku: string | null
  sourceLocationName: string | null
  destinationLocationName: string | null
}

type ProductSalesAnalytics = {
  months: number
  startDate: string
  endDate: string
  products: {
    productId: string
    name: string
    unitsSold: number
    trend: 'rising' | 'falling' | 'stable'
    changePercent: number | null
    variants: {
      variantId: string
      sku: string | null
      size: string | null
      color: string | null
      unitsSold: number
    }[]
    monthlySales: { month: string; unitsSold: number }[]
  }[]
}

type ApiErrorBody = {
  error?: {
    message?: string
  }
}

const accessTokenKey = 'stockcontroll.accessToken'
const selectedStoreKey = 'stockcontroll.selectedStoreId'
const movementTypeLabels: Record<MovementRecord['type'], string> = {
  entry: 'Entrada',
  exit: 'Salida',
  adjustment: 'Ajuste',
  transfer: 'Transferencia',
  return: 'Devolución',
}
const productTrendLabels = {
  rising: 'En alza',
  falling: 'En baja',
  stable: 'Estable',
} as const

function ProductThumbnail({ imageUrl, name }: { imageUrl: string | null; name: string }) {
  const [imageFailed, setImageFailed] = useState(false)

  if (!imageUrl || imageFailed) {
    return <span aria-label={`Sin foto para ${name}`} className="product-thumbnail-placeholder" role="img">▦</span>
  }

  return (
    <img
      alt={`Foto de ${name}`}
      className="product-thumbnail"
      loading="lazy"
      onError={() => setImageFailed(true)}
      referrerPolicy="no-referrer"
      src={imageUrl}
    />
  )
}

async function apiRequest<T>(
  path: string,
  token: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = new Headers(options.headers)
  headers.set('Authorization', `Bearer ${token}`)
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(path, { ...options, headers })
  const body: unknown = await response.json().catch(() => null)

  if (!response.ok) {
    const errorBody = body as ApiErrorBody | null
    throw new Error(errorBody?.error?.message ?? 'No se pudo completar la solicitud.')
  }

  return body as T
}

async function requestProductAnalytics(
  token: string,
  storeId: string,
  months: number,
): Promise<ProductSalesAnalytics> {
  const { data } = await apiRequest<{ data: ProductSalesAnalytics }>(
    `/api/stores/${storeId}/analytics/products?months=${months}`,
    token,
  )
  return data
}

function App() {
  const [accessToken, setAccessToken] = useState(
    () => sessionStorage.getItem(accessTokenKey) ?? '',
  )
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [stores, setStores] = useState<StoreSummary[]>([])
  const [selectedStoreId, setSelectedStoreId] = useState(
    () => sessionStorage.getItem(selectedStoreKey) ?? '',
  )
  const [products, setProducts] = useState<CatalogProduct[]>([])
  const [locations, setLocations] = useState<InventoryLocation[]>([])
  const [recentMovements, setRecentMovements] = useState<MovementRecord[]>([])
  const [activeSection, setActiveSection] = useState<'products' | 'movements' | 'analytics'>('products')
  const [showLowStockDetails, setShowLowStockDetails] = useState(false)
  const [productAnalytics, setProductAnalytics] = useState<ProductSalesAnalytics | null>(null)
  const [analyticsMonths, setAnalyticsMonths] = useState<6 | 12 | 24>(12)
  const [analyticsView, setAnalyticsView] = useState<'best-sellers' | 'seasonality' | 'trends'>('best-sellers')
  const [seasonalProductId, setSeasonalProductId] = useState('')
  const [search, setSearch] = useState('')
  const [selectedVariantId, setSelectedVariantId] = useState('')
  const [movementType, setMovementType] = useState<'entry' | 'exit' | 'adjustment' | 'return'>('entry')
  const [adjustmentDirection, setAdjustmentDirection] = useState<'increase' | 'decrease'>('increase')
  const [movementQuantity, setMovementQuantity] = useState('1')
  const [movementLocationId, setMovementLocationId] = useState('')
  const [movementReference, setMovementReference] = useState('')
  const [movementNotes, setMovementNotes] = useState('')
  const [pageLoading, setPageLoading] = useState(
    () => Boolean(sessionStorage.getItem(accessTokenKey)),
  )
  const [loginLoading, setLoginLoading] = useState(false)
  const [importLoading, setImportLoading] = useState(false)
  const [movementLoading, setMovementLoading] = useState(false)
  const [activityLoading, setActivityLoading] = useState(true)
  const [analyticsLoading, setAnalyticsLoading] = useState(true)
  const [ordersImportLoading, setOrdersImportLoading] = useState(false)
  const [error, setError] = useState('')
  const [analyticsError, setAnalyticsError] = useState('')
  const [analyticsNotice, setAnalyticsNotice] = useState('')
  const [notice, setNotice] = useState('')

  const selectedStore = stores.find((store) => store.id === selectedStoreId)
  const filteredProducts = useMemo(() => {
    const term = search.trim().toLocaleLowerCase()
    if (!term) return products

    return products.flatMap((product) => {
      if (product.name.toLocaleLowerCase().includes(term)) return [product]

      const matchingVariants = product.variants.filter((variant) =>
        [variant.sku, variant.size, variant.color]
          .filter(Boolean)
          .some((value) => value!.toLocaleLowerCase().includes(term)),
      )
      return matchingVariants.length > 0
        ? [{ ...product, variants: matchingVariants }]
        : []
    })
  }, [products, search])

  const variants = products.flatMap((product) => product.variants)
  const movementWritable = ['owner', 'admin', 'manager'].includes(selectedStore?.role ?? '')
  const totalUnits = variants.reduce((total, variant) => total + variant.quantity, 0)
  const lowStockVariants = variants.filter((variant) => variant.quantity <= 3).length
  const lowStockItems = products.flatMap((product) =>
    product.variants
      .filter((variant) => variant.quantity <= 3)
      .map((variant) => ({ product, variant })),
  )
  const seasonalProduct = productAnalytics?.products.find(
    (product) => product.productId === seasonalProductId,
  ) ?? productAnalytics?.products[0]
  const maximumMonthlySales = Math.max(
    1,
    ...(seasonalProduct?.monthlySales.map((month) => month.unitsSold) ?? []),
  )

  useEffect(() => {
    if (!accessToken) {
      return
    }

    let active = true
    apiRequest<{ data: StoreSummary[] }>('/api/auth/stores', accessToken)
      .then(({ data }) => {
        if (!active) return
        setStores(data)
        const previousStore = data.find((store) => store.id === selectedStoreId)
        const nextStoreId = previousStore?.id ?? data[0]?.id ?? ''
        if (nextStoreId && nextStoreId !== selectedStoreId) setPageLoading(true)
        setSelectedStoreId(nextStoreId)
        if (nextStoreId) sessionStorage.setItem(selectedStoreKey, nextStoreId)
      })
      .catch((requestError: unknown) => {
        if (!active) return
        setError(requestError instanceof Error ? requestError.message : 'No se pudieron cargar las tiendas.')
        sessionStorage.removeItem(accessTokenKey)
        setStores([])
        setProducts([])
        setLocations([])
        setRecentMovements([])
        setAccessToken('')
      })
      .finally(() => {
        if (active) setPageLoading(false)
      })

    return () => {
      active = false
    }
  }, [accessToken, selectedStoreId])

  useEffect(() => {
    if (!accessToken || !selectedStoreId) {
      return
    }

    let active = true
    Promise.all([
      apiRequest<{ data: InventoryLocation[] }>(
        `/api/stores/${selectedStoreId}/inventory/locations`,
        accessToken,
      ),
      apiRequest<{ data: MovementRecord[] }>(
        `/api/stores/${selectedStoreId}/inventory/movements`,
        accessToken,
      ),
    ])
      .then(([locationResponse, movementResponse]) => {
        if (!active) return
        setLocations(locationResponse.data)
        setRecentMovements(movementResponse.data)
        setMovementLocationId((currentId) => currentId || locationResponse.data[0]?.id || '')
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : 'No se pudo cargar el inventario.')
        }
      })
      .finally(() => {
        if (active) setActivityLoading(false)
      })

    return () => {
      active = false
    }
  }, [accessToken, selectedStoreId])

  useEffect(() => {
    if (!accessToken || !selectedStoreId) {
      return
    }

    let active = true
    requestProductAnalytics(accessToken, selectedStoreId, analyticsMonths)
      .then((data) => {
        if (active) {
          setProductAnalytics(data)
          setAnalyticsError('')
        }
      })
      .catch((requestError: unknown) => {
        if (active) {
          setAnalyticsError(
            requestError instanceof Error
              ? requestError.message
              : 'No se pudieron cargar las estadísticas de productos.',
          )
        }
      })
      .finally(() => {
        if (active) setAnalyticsLoading(false)
      })

    return () => {
      active = false
    }
  }, [accessToken, selectedStoreId, analyticsMonths])

  useEffect(() => {
    if (!accessToken || !selectedStoreId) {
      return
    }

    let active = true
    apiRequest<{ data: CatalogProduct[] }>(
      `/api/stores/${selectedStoreId}/inventory/products`,
      accessToken,
    )
      .then(({ data }) => {
        if (active) setProducts(data)
      })
      .catch((requestError: unknown) => {
        if (active) {
          setError(requestError instanceof Error ? requestError.message : 'No se pudo cargar el inventario.')
        }
      })
      .finally(() => {
        if (active) setPageLoading(false)
      })

    return () => {
      active = false
    }
  }, [accessToken, selectedStoreId])

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoginLoading(true)
    setError('')

    try {
      const { accessToken: token } = await apiRequest<{ accessToken: string }>(
        '/api/auth/login',
        '',
        { method: 'POST', body: JSON.stringify({ email, password }) },
      )
      sessionStorage.setItem(accessTokenKey, token)
      setPageLoading(true)
      setAccessToken(token)
      setPassword('')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo iniciar sesión.')
    } finally {
      setLoginLoading(false)
    }
  }

  function handleLogout() {
    sessionStorage.removeItem(accessTokenKey)
    sessionStorage.removeItem(selectedStoreKey)
    setAccessToken('')
    setSelectedStoreId('')
    setStores([])
    setProducts([])
    setLocations([])
    setRecentMovements([])
    setProductAnalytics(null)
    setNotice('')
    setAnalyticsNotice('')
    setAnalyticsError('')
    setError('')
  }

  async function importCatalog() {
    if (!accessToken || !selectedStoreId) return
    setImportLoading(true)
    setError('')
    setNotice('Conectando con Tiendanube para importar el catálogo...')

    try {
      let page = 1
      let importedProducts = 0
      let updatedProducts = 0
      let importedVariants = 0
      let updatedVariants = 0
      let openingStockUnits = 0
      let orderWebhooksActive = false

      while (page <= 10_000) {
        const { data } = await apiRequest<{
          data: {
            importedProducts: number
            updatedProducts: number
            importedVariants: number
            updatedVariants: number
            openingStockUnits: number
            hasNextPage: boolean
            orderWebhooksActive: boolean
          }
        }>(
          `/api/stores/${selectedStoreId}/integrations/tiendanube/products/import?page=${page}`,
          accessToken,
          { method: 'POST' },
        )

        importedProducts += data.importedProducts
        updatedProducts += data.updatedProducts
        importedVariants += data.importedVariants
        updatedVariants += data.updatedVariants
        openingStockUnits += data.openingStockUnits
        orderWebhooksActive = data.orderWebhooksActive
        if (!data.hasNextPage) break
        page += 1
      }

      if (page > 10_000) {
        throw new Error('El catálogo supera el límite seguro de páginas por importación.')
      }

      const { data } = await apiRequest<{ data: CatalogProduct[] }>(
        `/api/stores/${selectedStoreId}/inventory/products`,
        accessToken,
      )
      setProducts(data)
      setNotice(
        `Catálogo actualizado: ${importedProducts} productos y ${importedVariants} variantes nuevas; ` +
          `${updatedProducts + updatedVariants} registros actualizados. ` +
          `${openingStockUnits} unidades cargadas como stock inicial. ` +
          (orderWebhooksActive
            ? 'La recepción automática de pedidos de Tiendanube quedó activada.'
            : ''),
      )
    } catch (requestError) {
      setNotice('')
      setError(requestError instanceof Error ? requestError.message : 'No se pudo importar el catálogo.')
    } finally {
      setImportLoading(false)
    }
  }

  async function importOrderHistory() {
    if (!accessToken || !selectedStoreId || !['owner', 'admin'].includes(selectedStore?.role ?? '')) {
      return
    }

    setOrdersImportLoading(true)
    setAnalyticsError('')
    setAnalyticsNotice('Importando pedidos anteriores de Tiendanube...')
    try {
      let page = 1
      let ordersProcessed = 0
      while (page <= 334) {
        const { data } = await apiRequest<{
          data: { ordersProcessed: number; hasNextPage: boolean }
        }>(
          `/api/stores/${selectedStoreId}/integrations/tiendanube/orders/import?page=${page}`,
          accessToken,
          { method: 'POST' },
        )
        ordersProcessed += data.ordersProcessed
        setAnalyticsNotice(`Importando pedidos anteriores... ${ordersProcessed} pedidos revisados.`)
        if (!data.hasNextPage) break
        page += 1
      }

      const analytics = await requestProductAnalytics(accessToken, selectedStoreId, analyticsMonths)
      setProductAnalytics(analytics)
      setAnalyticsNotice(
        `${ordersProcessed} pedidos sincronizados. Las estadísticas cuentan solo pedidos pagados y no cancelados.`,
      )
    } catch (requestError) {
      setAnalyticsNotice('')
      setAnalyticsError(
        requestError instanceof Error
          ? requestError.message
          : 'No se pudieron importar los pedidos anteriores.',
      )
    } finally {
      setOrdersImportLoading(false)
      setAnalyticsLoading(false)
    }
  }

  async function submitMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!accessToken || !selectedStoreId || !movementWritable) return

    const variantId = selectedVariantId || variants[0]?.id
    const locationId = movementLocationId || locations[0]?.id
    const quantity = Number(movementQuantity)
    if (!variantId || !locationId || !Number.isSafeInteger(quantity) || quantity < 1) {
      setError('Elegí una variante y una ubicación, e ingresá una cantidad entera mayor a cero.')
      return
    }

    const payload: Record<string, string | number> = {
      type: movementType,
      quantity,
      productVariantId: variantId,
    }
    if (movementType === 'entry' || movementType === 'return') {
      payload.destinationLocationId = locationId
    } else if (movementType === 'exit') {
      payload.sourceLocationId = locationId
    } else {
      payload.locationId = locationId
      payload.direction = adjustmentDirection
    }
    if (movementReference.trim()) payload.reference = movementReference.trim()
    if (movementNotes.trim()) payload.notes = movementNotes.trim()

    setMovementLoading(true)
    setError('')
    setNotice('')
    try {
      await apiRequest<{ data: MovementRecord }>(
        `/api/stores/${selectedStoreId}/inventory/movements`,
        accessToken,
        { method: 'POST', body: JSON.stringify(payload) },
      )
      const [catalogResponse, movementResponse] = await Promise.all([
        apiRequest<{ data: CatalogProduct[] }>(
          `/api/stores/${selectedStoreId}/inventory/products`,
          accessToken,
        ),
        apiRequest<{ data: MovementRecord[] }>(
          `/api/stores/${selectedStoreId}/inventory/movements`,
          accessToken,
        ),
      ])
      setProducts(catalogResponse.data)
      setRecentMovements(movementResponse.data)
      setMovementQuantity('1')
      setMovementReference('')
      setMovementNotes('')
      setNotice('Movimiento registrado. El inventario se actualizó correctamente.')
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'No se pudo registrar el movimiento.')
    } finally {
      setMovementLoading(false)
    }
  }

  if (!accessToken) {
    return (
      <main className="login-page">
        <section className="login-card">
          <div className="brand-lockup">
            <span className="brand-mark">S</span>
            <span>StockControll</span>
          </div>
          <p className="eyebrow">GESTIÓN DE INVENTARIO</p>
          <h1>Ingresá a tu cuenta</h1>
          <p className="login-description">
            Accedé a tus productos, variantes y stock desde un solo lugar.
          </p>
          <form className="login-form" onSubmit={handleLogin}>
            <label htmlFor="email">Email</label>
            <input
              autoComplete="username"
              id="email"
              onChange={(event) => setEmail(event.target.value)}
              placeholder="tu@email.com"
              required
              type="email"
              value={email}
            />
            <label htmlFor="password">Contraseña</label>
            <input
              autoComplete="current-password"
              id="password"
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
            {error && <p className="feedback error" role="alert">{error}</p>}
            <button className="primary-button login-button" disabled={loginLoading} type="submit">
              {loginLoading ? 'Ingresando…' : 'Ingresar'}
            </button>
          </form>
          <p className="login-footnote">Tu sesión se mantiene solo en esta pestaña.</p>
        </section>
      </main>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a aria-label="StockControll, inicio" className="brand-lockup" href="#inicio">
          <span className="brand-mark">S</span>
          <span>StockControll</span>
        </a>
        <p className="nav-heading">GESTIÓN</p>
        <nav aria-label="Navegación principal" className="main-nav">
          <button
            aria-current={activeSection === 'products' ? 'page' : undefined}
            className={`nav-item${activeSection === 'products' ? ' active' : ''}`}
            onClick={() => setActiveSection('products')}
            type="button"
          >
            <span aria-hidden="true">▦</span> Productos
          </button>
          <button
            aria-current={activeSection === 'movements' ? 'page' : undefined}
            className={`nav-item${activeSection === 'movements' ? ' active' : ''}`}
            onClick={() => setActiveSection('movements')}
            type="button"
          >
            <span aria-hidden="true">⇄</span> Movimientos
          </button>
          <button
            aria-current={activeSection === 'analytics' ? 'page' : undefined}
            className={`nav-item${activeSection === 'analytics' ? ' active' : ''}`}
            onClick={() => setActiveSection('analytics')}
            type="button"
          >
            <span aria-hidden="true">▥</span> Estadísticas
          </button>
        </nav>
        <div className="sidebar-bottom">
          <div className="connection-card">
            <span className="connection-dot" />
            <div>
              <strong>Tu inventario</strong>
              <span>Datos de tu tienda</span>
            </div>
          </div>
          <button className="user-button" onClick={handleLogout} type="button">
            <span className="avatar">{email.charAt(0).toUpperCase() || 'U'}</span>
            <span className="user-email">{email}</span>
            <span aria-hidden="true">↪</span>
          </button>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">
            StockControll <span>/</span> {
              activeSection === 'products' ? 'Productos'
                : activeSection === 'movements' ? 'Movimientos'
                  : 'Estadísticas'
            }
          </div>
          <label className="store-picker">
            <span>Tienda</span>
            <select
              aria-label="Seleccionar tienda"
              onChange={(event) => {
                setPageLoading(true)
                setActivityLoading(true)
                setProducts([])
                setLocations([])
                setRecentMovements([])
                setProductAnalytics(null)
                setActivityLoading(true)
                setAnalyticsLoading(true)
                setAnalyticsError('')
                setAnalyticsNotice('')
                setError('')
                setSelectedStoreId(event.target.value)
                sessionStorage.setItem(selectedStoreKey, event.target.value)
              }}
              value={selectedStoreId}
            >
              {stores.map((store) => (
                <option key={store.id} value={store.id}>{store.name}</option>
              ))}
            </select>
          </label>
        </header>

        <section className="page-content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">TU NEGOCIO, ORDENADO</p>
              <h1>
                {activeSection === 'products' ? 'Productos e inventario'
                  : activeSection === 'movements' ? 'Movimientos de inventario'
                    : 'Estadísticas de productos'}
              </h1>
              <p className="page-description">
                {activeSection === 'products'
                  ? `Consultá las variantes y el stock de ${selectedStore?.name ?? 'tu tienda'}.`
                  : activeSection === 'movements'
                    ? 'Registrá y consultá los cambios de stock de tu tienda.'
                    : 'Analizá los productos más vendidos, su estacionalidad y las tendencias de demanda.'}
              </p>
            </div>
            {activeSection === 'products' && (
              <button
                className="primary-button import-button"
                disabled={
                  importLoading ||
                  !selectedStoreId ||
                  !['owner', 'admin'].includes(selectedStore?.role ?? '')
                }
                onClick={importCatalog}
                type="button"
              >
                <span aria-hidden="true">↻</span>
                {importLoading ? 'Importando catálogo…' : 'Importar desde Tiendanube'}
              </button>
            )}
          </div>

          {error && <p className="feedback error page-feedback" role="alert">{error}</p>}
          {notice && <p className="feedback success page-feedback" role="status">{notice}</p>}

          {activeSection === 'products' && <section aria-label="Resumen del inventario" className="summary-grid">
            <article className="summary-card">
              <span className="summary-icon violet" aria-hidden="true">▦</span>
              <div><span>Productos</span><strong>{products.length}</strong></div>
              <small>en tu catálogo</small>
            </article>
            <article className="summary-card">
              <span className="summary-icon blue" aria-hidden="true">◇</span>
              <div><span>Variantes</span><strong>{variants.length}</strong></div>
              <small>talles y colores</small>
            </article>
            <article className="summary-card">
              <span className="summary-icon green" aria-hidden="true">▤</span>
              <div><span>Unidades disponibles</span><strong>{totalUnits}</strong></div>
              <small>suma en todas las ubicaciones</small>
            </article>
            <button
              aria-expanded={showLowStockDetails}
              aria-controls={showLowStockDetails ? 'low-stock-details' : undefined}
              className="summary-card summary-action"
              onClick={() => setShowLowStockDetails((isOpen) => !isOpen)}
              type="button"
            >
              <span className="summary-icon orange" aria-hidden="true">!</span>
              <div><span>Stock bajo</span><strong>{lowStockVariants}</strong></div>
              <small>{showLowStockDetails ? 'ocultar detalle' : 'ver variantes con hasta 3 unidades'}</small>
            </button>
          </section>
          }

          {activeSection === 'products' && showLowStockDetails && (
            <section aria-labelledby="low-stock-title" className="low-stock-details" id="low-stock-details">
              <div className="low-stock-heading">
                <div>
                  <h2 id="low-stock-title">Variantes con stock bajo</h2>
                  <p>Se muestran las variantes con 3 unidades disponibles o menos, sumando todas las ubicaciones.</p>
                </div>
                <button
                  aria-label="Cerrar detalle de stock bajo"
                  className="low-stock-close"
                  onClick={() => setShowLowStockDetails(false)}
                  type="button"
                >
                  ×
                </button>
              </div>
              {lowStockItems.length === 0 ? (
                <p className="low-stock-empty">No hay variantes con stock bajo.</p>
              ) : (
                <ul className="low-stock-list">
                  {lowStockItems.map(({ product, variant }) => (
                    <li className="low-stock-item" key={variant.id}>
                      <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />
                      <div className="low-stock-product">
                        <strong>{product.name}</strong>
                        <span>
                          {[
                            variant.size,
                            variant.color,
                            variant.sku ? `SKU ${variant.sku}` : null,
                          ].filter(Boolean).join(' · ') || 'Variante estándar'}
                        </span>
                      </div>
                      <strong className="low-stock-quantity">{variant.quantity} un.</strong>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {activeSection === 'analytics' && <section aria-labelledby="product-analytics-title" className="analytics-panel">
            <div className="analytics-heading">
              <div>
                <h2 id="product-analytics-title">Estadísticas de productos</h2>
                <p>Productos más vendidos y cómo cambia su demanda mes a mes.</p>
              </div>
              <div className="analytics-actions">
                <label className="period-picker">
                  <span>Período</span>
                  <select
                    disabled={analyticsLoading || ordersImportLoading}
                    onChange={(event) => {
                      setAnalyticsLoading(true)
                      setAnalyticsMonths(Number(event.target.value) as 6 | 12 | 24)
                    }}
                    value={analyticsMonths}
                  >
                    <option value={6}>6 meses</option>
                    <option value={12}>12 meses</option>
                    <option value={24}>24 meses</option>
                  </select>
                </label>
                <button
                  className="secondary-button"
                  disabled={
                    ordersImportLoading ||
                    !selectedStoreId ||
                    !['owner', 'admin'].includes(selectedStore?.role ?? '')
                  }
                  onClick={importOrderHistory}
                  type="button"
                >
                  {ordersImportLoading ? 'Sincronizando…' : 'Sincronizar ventas anteriores'}
                </button>
              </div>
            </div>
            {analyticsError && <p className="feedback error" role="alert">{analyticsError}</p>}
            {analyticsNotice && <p className="feedback success" role="status">{analyticsNotice}</p>}
            {analyticsLoading ? (
              <div className="analytics-empty">Cargando estadísticas…</div>
            ) : productAnalytics && productAnalytics.products.length > 0 ? (
              <>
                <nav aria-label="Tipo de estadísticas" className="analytics-tabs">
                  <button
                    aria-pressed={analyticsView === 'best-sellers'}
                    className={analyticsView === 'best-sellers' ? 'active' : ''}
                    onClick={() => setAnalyticsView('best-sellers')}
                    type="button"
                  >
                    Más vendidos
                  </button>
                  <button
                    aria-pressed={analyticsView === 'seasonality'}
                    className={analyticsView === 'seasonality' ? 'active' : ''}
                    onClick={() => setAnalyticsView('seasonality')}
                    type="button"
                  >
                    Estacionalidad
                  </button>
                  <button
                    aria-pressed={analyticsView === 'trends'}
                    className={analyticsView === 'trends' ? 'active' : ''}
                    onClick={() => setAnalyticsView('trends')}
                    type="button"
                  >
                    Tendencias
                  </button>
                </nav>
                <div className="analytics-content">
                {analyticsView === 'best-sellers' && (
                <section aria-labelledby="best-sellers-title" className="analytics-section">
                  <div className="analytics-section-heading">
                    <div>
                      <p className="analytics-kicker">RANKING</p>
                      <h3 id="best-sellers-title">Los más vendidos</h3>
                      <p>Unidades vendidas durante el período seleccionado.</p>
                    </div>
                    <span className="analytics-period">
                      {productAnalytics.startDate} — {productAnalytics.endDate}
                    </span>
                  </div>
                  <div className="best-seller-list">
                    {productAnalytics.products.map((product, index) => (
                      <article className="best-seller-row" key={product.productId}>
                        <span aria-label={`Puesto ${index + 1}`} className={`ranking-number${index < 3 ? ' top-three' : ''}`}>
                          {index + 1}
                        </span>
                        <div className="best-seller-info">
                          <h4>{product.name}</h4>
                          {product.variants.length > 0 && (
                            <details className="variant-sales">
                              <summary>Ventas por variante</summary>
                              <ul>
                                {product.variants.map((variant) => {
                                  const description = [
                                    variant.size,
                                    variant.color,
                                    variant.sku ? `SKU ${variant.sku}` : null,
                                  ].filter(Boolean).join(' · ')
                                  return (
                                    <li key={variant.variantId}>
                                      <span>{description || 'Variante sin detalle'}</span>
                                      <strong>{variant.unitsSold}</strong>
                                    </li>
                                  )
                                })}
                              </ul>
                            </details>
                          )}
                        </div>
                        <div className="best-seller-units">
                          <strong>{product.unitsSold}</strong>
                          <span>{product.unitsSold === 1 ? 'unidad' : 'unidades'}</span>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
                )}

                {analyticsView === 'seasonality' && (
                <section aria-labelledby="seasonality-title" className="analytics-section seasonality-section">
                  <div className="analytics-section-heading">
                    <div>
                      <p className="analytics-kicker">COMPORTAMIENTO MENSUAL</p>
                      <h3 id="seasonality-title">¿Cuándo se vende más?</h3>
                      <p>Unidades vendidas por mes del producto elegido.</p>
                    </div>
                    <label className="period-picker product-picker">
                      <span>Producto</span>
                      <select
                        onChange={(event) => setSeasonalProductId(event.target.value)}
                        value={seasonalProduct?.productId ?? ''}
                      >
                        {productAnalytics.products.map((product) => (
                          <option key={product.productId} value={product.productId}>{product.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div aria-label={`Unidades vendidas por mes para ${seasonalProduct?.name ?? 'el producto seleccionado'}`} className="monthly-chart">
                    {(seasonalProduct?.monthlySales ?? []).map((month) => {
                      const height = month.unitsSold === 0
                        ? 3
                        : Math.max(8, (month.unitsSold / maximumMonthlySales) * 100)
                      const label = new Intl.DateTimeFormat('es-AR', {
                        month: 'short',
                        year: '2-digit',
                        timeZone: 'UTC',
                      }).format(new Date(`${month.month}-01T00:00:00Z`))
                      return (
                        <div className="monthly-chart-item" key={month.month} title={`${label}: ${month.unitsSold} unidades`}>
                          <span className="monthly-chart-value">{month.unitsSold}</span>
                          <div className="monthly-chart-track">
                            <span className="monthly-chart-bar" style={{ height: `${height}%` }} />
                          </div>
                          <span className="monthly-chart-label">{label}</span>
                        </div>
                      )
                    })}
                  </div>
                  <p className="trend-caption">
                    Solo se incluyen pedidos pagados y no cancelados de Tiendanube.
                  </p>
                </section>
                )}

                {analyticsView === 'trends' && (
                  <section aria-labelledby="trends-title" className="analytics-section">
                    <div className="analytics-section-heading">
                      <div>
                        <p className="analytics-kicker">CAMBIO EN LA DEMANDA</p>
                        <h3 id="trends-title">Tendencias de productos</h3>
                        <p>Compara las unidades vendidas en dos períodos consecutivos.</p>
                      </div>
                      <span className="analytics-period">Últimos 3 meses completos vs. los 3 anteriores</span>
                    </div>
                    <div className="trend-list">
                      {productAnalytics.products.map((product) => (
                        <article className="trend-row" key={product.productId}>
                          <div className="trend-product">
                            <h4>{product.name}</h4>
                            <span>{product.unitsSold} {product.unitsSold === 1 ? 'unidad vendida' : 'unidades vendidas'} en el período</span>
                          </div>
                          <span className={`trend-pill ${product.trend}`}>
                            {productTrendLabels[product.trend]}
                          </span>
                          <strong className={`trend-change ${product.trend}`}>
                            {product.changePercent === null
                              ? 'Sin ventas previas'
                              : `${product.changePercent > 0 ? '+' : ''}${product.changePercent}%`}
                          </strong>
                        </article>
                      ))}
                    </div>
                    <p className="trend-caption">
                      Un cambio de al menos 10% se considera alza o baja. Variaciones menores se muestran como estables.
                    </p>
                  </section>
                )}
              </div>
              </>
            ) : (
              <div className="analytics-empty">
                Todavía no hay ventas pagadas en este período. Sincronizá los pedidos anteriores de Tiendanube para empezar.
              </div>
            )}
          </section>
          }

          {activeSection === 'movements' && <>
          <section aria-labelledby="movement-form-title" className="movement-panel">
            <div className="movement-panel-heading">
              <div>
                <h2 id="movement-form-title">Registrar movimiento</h2>
                <p>Cada cambio queda guardado en el historial del inventario.</p>
              </div>
              <span className="audit-badge">Movimiento auditable</span>
            </div>
            {products.length === 0 ? (
              <div className="movement-unavailable">
                Importá primero el catálogo para registrar movimientos de stock.
              </div>
            ) : locations.length === 0 ? (
              <div className="movement-unavailable">
                {activityLoading ? 'Cargando ubicaciones…' : 'No hay ubicaciones activas para esta tienda.'}
              </div>
            ) : (
              <form className="movement-form" onSubmit={submitMovement}>
                <label>
                  Tipo de movimiento
                  <select
                    disabled={!movementWritable || movementLoading}
                    onChange={(event) => setMovementType(event.target.value as typeof movementType)}
                    value={movementType}
                  >
                    <option value="entry">Entrada</option>
                    <option value="exit">Salida</option>
                    <option value="adjustment">Ajuste</option>
                    <option value="return">Devolución</option>
                  </select>
                </label>
                <label className="variant-field">
                  Producto / variante
                  <select
                    disabled={!movementWritable || movementLoading}
                    onChange={(event) => setSelectedVariantId(event.target.value)}
                    required
                    value={selectedVariantId || variants[0]?.id || ''}
                  >
                    {variants.map((variant) => {
                      const product = products.find((candidate) =>
                        candidate.variants.some((item) => item.id === variant.id),
                      )
                      const description = [variant.size, variant.color].filter(Boolean).join(' · ')
                      return (
                        <option key={variant.id} value={variant.id}>
                          {product?.name ?? 'Producto'} — {variant.sku ? `SKU ${variant.sku}` : 'Sin SKU'}
                          {description ? ` (${description})` : ''}
                        </option>
                      )
                    })}
                  </select>
                </label>
                <label>
                  Ubicación
                  <select
                    disabled={!movementWritable || movementLoading}
                    onChange={(event) => setMovementLocationId(event.target.value)}
                    required
                    value={movementLocationId || locations[0]?.id || ''}
                  >
                    {locations.map((location) => (
                      <option key={location.id} value={location.id}>{location.name}</option>
                    ))}
                  </select>
                </label>
                {movementType === 'adjustment' && (
                  <label>
                    Ajuste
                    <select
                      disabled={!movementWritable || movementLoading}
                      onChange={(event) => setAdjustmentDirection(event.target.value as typeof adjustmentDirection)}
                      value={adjustmentDirection}
                    >
                      <option value="increase">Aumentar stock</option>
                      <option value="decrease">Disminuir stock</option>
                    </select>
                  </label>
                )}
                <label>
                  Cantidad
                  <input
                    disabled={!movementWritable || movementLoading}
                    max="2147483647"
                    min="1"
                    onChange={(event) => setMovementQuantity(event.target.value)}
                    required
                    step="1"
                    type="number"
                    value={movementQuantity}
                  />
                </label>
                <label>
                  Referencia <span className="optional-label">Opcional</span>
                  <input
                    disabled={!movementWritable || movementLoading}
                    maxLength={150}
                    onChange={(event) => setMovementReference(event.target.value)}
                    placeholder="Ej. compra, pedido o comprobante"
                    value={movementReference}
                  />
                </label>
                <label className="notes-field">
                  Nota <span className="optional-label">Opcional</span>
                  <input
                    disabled={!movementWritable || movementLoading}
                    maxLength={10000}
                    onChange={(event) => setMovementNotes(event.target.value)}
                    placeholder="Agregá un detalle para el historial"
                    value={movementNotes}
                  />
                </label>
                {movementWritable ? (
                  <button className="primary-button movement-submit" disabled={movementLoading} type="submit">
                    {movementLoading ? 'Guardando…' : 'Registrar movimiento'}
                  </button>
                ) : (
                  <p className="permission-note movement-permission">
                    Tu rol puede consultar el inventario, pero no modificarlo.
                  </p>
                )}
              </form>
            )}
          </section>

          <section aria-labelledby="recent-movements-title" className="catalog-card recent-movements">
            <div className="catalog-toolbar">
              <div>
                <h2 id="recent-movements-title">Movimientos recientes</h2>
                <p>Últimos 25 cambios registrados en esta tienda</p>
              </div>
            </div>
            {activityLoading ? (
              <div className="empty-state"><span className="loader" /> Cargando movimientos…</div>
            ) : recentMovements.length === 0 ? (
              <div className="empty-state compact">Todavía no hay movimientos registrados.</div>
            ) : (
              <div className="table-scroll">
                <table className="product-table">
                  <thead>
                    <tr>
                      <th>Tipo</th>
                      <th>Producto / SKU</th>
                      <th>Ubicación</th>
                      <th>Referencia</th>
                      <th className="quantity-cell">Cantidad</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentMovements.map((movement) => {
                      const isDecrease =
                        movement.type === 'exit' ||
                        (movement.type === 'adjustment' && Boolean(movement.sourceLocationName))
                      const locationName = movement.type === 'exit'
                        ? movement.sourceLocationName
                        : movement.destinationLocationName ?? movement.sourceLocationName
                      return (
                        <tr key={movement.id}>
                          <td>
                            <span className={`movement-type-pill ${isDecrease ? 'decrease' : 'increase'}`}>
                              {movementTypeLabels[movement.type]}
                            </span>
                          </td>
                          <td>
                            <div className="product-name">{movement.productName}</div>
                            <span className="sku-label">{movement.sku ? `SKU ${movement.sku}` : 'Sin SKU'}</span>
                          </td>
                          <td>{locationName ?? '—'}</td>
                          <td>{movement.reference ?? '—'}</td>
                          <td className="quantity-cell">
                            <span className={`movement-quantity ${isDecrease ? 'decrease' : 'increase'}`}>
                              {isDecrease ? '−' : '+'}{movement.quantity}
                            </span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          </>}

          {activeSection === 'products' && <section aria-labelledby="catalog-title" className="catalog-card">
            <div className="catalog-toolbar">
              <div>
                <h2 id="catalog-title">Catálogo</h2>
                <p>Productos, SKU y cantidades disponibles</p>
              </div>
              <label className="search-field">
                <span aria-hidden="true">⌕</span>
                <input
                  aria-label="Buscar productos o SKU"
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Buscar producto o SKU"
                  type="search"
                  value={search}
                />
              </label>
            </div>

            {pageLoading ? (
              <div className="empty-state"><span className="loader" /> Cargando inventario…</div>
            ) : products.length === 0 ? (
              <div className="empty-state">
                <span className="empty-icon" aria-hidden="true">▦</span>
                <h3>Tu catálogo está vacío</h3>
                <p>Importá los productos de Tiendanube para empezar a gestionar el inventario.</p>
                <button
                  className="primary-button"
                  disabled={
                    importLoading ||
                    !selectedStoreId ||
                    !['owner', 'admin'].includes(selectedStore?.role ?? '')
                  }
                  onClick={importCatalog}
                  type="button"
                >
                  {importLoading ? 'Importando…' : 'Importar catálogo'}
                </button>
                {!['owner', 'admin'].includes(selectedStore?.role ?? '') && (
                  <p className="permission-note">Pedile a la persona propietaria o administradora que importe el catálogo.</p>
                )}
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="empty-state compact">No encontramos productos que coincidan con “{search}”.</div>
            ) : (
              <div className="table-scroll">
                <table className="product-table">
                  <thead>
                    <tr>
                      <th>Producto / SKU</th>
                      <th>Variante</th>
                      <th>Origen</th>
                      <th className="quantity-cell">Stock disponible</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProducts.map((product) => (
                      product.variants.length > 0
                        ? product.variants.map((variant, index) => (
                          <tr key={variant.id}>
                            <td>
                              <div className="catalog-product">
                                {index === 0 && <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />}
                                <div className="product-name">
                                  {index === 0 ? product.name : <span className="continued-product">{product.name}</span>}
                                </div>
                              </div>
                              <span className="sku-label">{variant.sku ? `SKU ${variant.sku}` : 'Sin SKU'}</span>
                            </td>
                            <td>
                              {[variant.size, variant.color].filter(Boolean).join(' · ') || 'Estándar'}
                            </td>
                            <td>
                              {product.tiendanubeProductId
                                ? <span className="source-badge"><span /> Tiendanube</span>
                                : <span className="source-local">Local</span>}
                            </td>
                            <td className="quantity-cell">
                              <span className={`stock-pill ${variant.quantity <= 3 ? 'low' : 'normal'}`}>
                                {variant.quantity} un.
                              </span>
                            </td>
                          </tr>
                        ))
                        : (
                          <tr key={product.id}>
                            <td>
                              <div className="catalog-product">
                                <ProductThumbnail imageUrl={product.imageUrl} name={product.name} />
                                <div className="product-name">{product.name}</div>
                              </div>
                            </td>
                            <td>Sin variantes</td>
                            <td>{product.tiendanubeProductId ? 'Tiendanube' : 'Local'}</td>
                            <td className="quantity-cell"><span className="stock-pill low">0 un.</span></td>
                          </tr>
                        )
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {products.length > 0 && (
              <div className="catalog-footer">
                Mostrando {filteredProducts.length} de {products.length} productos
                <span>Los cambios de stock se administran desde StockControll.</span>
              </div>
            )}
          </section>
          }
          <footer className="page-footer">StockControll <span>·</span> Inventario centralizado para tu negocio</footer>
        </section>
      </main>
    </div>
  )
}

export default App
