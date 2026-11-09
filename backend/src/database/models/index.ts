import {
  CreationOptional,
  DataTypes,
  InferAttributes,
  InferCreationAttributes,
  Model,
  NonAttribute
} from 'sequelize';
import { sequelize } from '../sequelize.js';

export class Store extends Model<InferAttributes<Store>, InferCreationAttributes<Store>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare timezone: CreationOptional<string>;
  declare currency: CreationOptional<string>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare products?: NonAttribute<Product[]>;
  declare locations?: NonAttribute<Location[]>;
  declare memberships?: NonAttribute<StoreMembership[]>;
  declare tiendanubeConnection?: NonAttribute<TiendanubeConnection>;
}

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare email: string;
  declare passwordHash: string;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare memberships?: NonAttribute<StoreMembership[]>;
}

export class StoreMembership extends Model<
  InferAttributes<StoreMembership>,
  InferCreationAttributes<StoreMembership>
> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare userId: string;
  declare role: 'owner' | 'admin' | 'manager' | 'staff';
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare store?: NonAttribute<Store>;
  declare user?: NonAttribute<User>;
}

export class TiendanubeConnection extends Model<
  InferAttributes<TiendanubeConnection>,
  InferCreationAttributes<TiendanubeConnection>
> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare externalStoreId: string;
  declare encryptedAccessToken: string;
  declare tokenIv: string;
  declare tokenAuthTag: string;
  declare grantedScopes: string;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare store?: NonAttribute<Store>;
}

export class TiendanubeOrder extends Model<
  InferAttributes<TiendanubeOrder>,
  InferCreationAttributes<TiendanubeOrder>
> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare externalOrderId: string;
  declare orderStatus: string;
  declare paymentStatus: string;
  declare createdAtProvider: Date | null;
  declare paidAtProvider: Date | null;
  declare currency: string | null;
  declare total: string | null;
  declare isCancelled: boolean;
  declare inventoryTracked: boolean;
  declare lastSyncedAt: CreationOptional<Date>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class TiendanubeOrderLine extends Model<
  InferAttributes<TiendanubeOrderLine>,
  InferCreationAttributes<TiendanubeOrderLine>
> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare orderId: string;
  declare externalVariantId: string;
  declare productVariantId: string;
  declare quantity: number;
  declare stockAppliedQuantity: number;
  declare unitPrice: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class Product extends Model<InferAttributes<Product>, InferCreationAttributes<Product>> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare tiendanubeProductId: string | null;
  declare name: string;
  declare description: string | null;
  declare imageUrl: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare store?: NonAttribute<Store>;
  declare variants?: NonAttribute<ProductVariant[]>;
}

export class ProductVariant extends Model<
  InferAttributes<ProductVariant>,
  InferCreationAttributes<ProductVariant>
> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare productId: string;
  declare tiendanubeVariantId: string | null;
  declare sku: string | null;
  declare barcode: string | null;
  declare size: string | null;
  declare color: string | null;
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare product?: NonAttribute<Product>;
  declare balances?: NonAttribute<InventoryBalance[]>;
}

export class Location extends Model<InferAttributes<Location>, InferCreationAttributes<Location>> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare name: string;
  declare type: 'store' | 'warehouse' | 'other';
  declare isActive: CreationOptional<boolean>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare store?: NonAttribute<Store>;
  declare balances?: NonAttribute<InventoryBalance[]>;
}

export class InventoryBalance extends Model<
  InferAttributes<InventoryBalance>,
  InferCreationAttributes<InventoryBalance>
> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare productVariantId: string;
  declare locationId: string;
  declare quantity: CreationOptional<number>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  declare variant?: NonAttribute<ProductVariant>;
  declare location?: NonAttribute<Location>;
}

export class InventoryMovement extends Model<
  InferAttributes<InventoryMovement>,
  InferCreationAttributes<InventoryMovement>
> {
  declare id: CreationOptional<string>;
  declare storeId: string;
  declare productVariantId: string;
  declare type: 'entry' | 'exit' | 'adjustment' | 'transfer' | 'return';
  declare quantity: number;
  declare sourceLocationId: string | null;
  declare destinationLocationId: string | null;
  declare reference: string | null;
  declare notes: string | null;
  declare createdAt: CreationOptional<Date>;

  declare variant?: NonAttribute<ProductVariant>;
  declare sourceLocation?: NonAttribute<Location>;
  declare destinationLocation?: NonAttribute<Location>;
}

Store.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    name: { type: DataTypes.STRING(150), allowNull: false },
    timezone: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'America/Argentina/Buenos_Aires' },
    currency: { type: DataTypes.STRING(3), allowNull: false, defaultValue: 'ARS' },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'stores', underscored: true }
);

User.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    email: { type: DataTypes.STRING(254), allowNull: false, unique: true },
    passwordHash: { type: DataTypes.STRING(100), allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'users', underscored: true }
);

StoreMembership.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    userId: { type: DataTypes.UUID, allowNull: false },
    role: { type: DataTypes.STRING(20), allowNull: false },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'store_memberships', underscored: true }
);

TiendanubeConnection.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    externalStoreId: { type: DataTypes.STRING(64), allowNull: false },
    encryptedAccessToken: { type: DataTypes.TEXT, allowNull: false },
    tokenIv: { type: DataTypes.STRING(24), allowNull: false },
    tokenAuthTag: { type: DataTypes.STRING(32), allowNull: false },
    grantedScopes: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'tiendanube_connections', underscored: true }
);

TiendanubeOrder.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    externalOrderId: { type: DataTypes.STRING(64), allowNull: false },
    orderStatus: { type: DataTypes.STRING(64), allowNull: false },
    paymentStatus: { type: DataTypes.STRING(64), allowNull: false },
    createdAtProvider: { type: DataTypes.DATE, allowNull: true },
    paidAtProvider: { type: DataTypes.DATE, allowNull: true },
    currency: { type: DataTypes.STRING(3), allowNull: true },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    isCancelled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    inventoryTracked: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    lastSyncedAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'tiendanube_orders', underscored: true }
);

TiendanubeOrderLine.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    orderId: { type: DataTypes.UUID, allowNull: false },
    externalVariantId: { type: DataTypes.STRING(64), allowNull: false },
    productVariantId: { type: DataTypes.UUID, allowNull: false },
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    stockAppliedQuantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    unitPrice: { type: DataTypes.DECIMAL(12, 2), allowNull: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'tiendanube_order_lines', underscored: true }
);

Product.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    tiendanubeProductId: { type: DataTypes.STRING(64), allowNull: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    imageUrl: { type: DataTypes.TEXT, allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'products', underscored: true }
);

ProductVariant.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    productId: { type: DataTypes.UUID, allowNull: false },
    tiendanubeVariantId: { type: DataTypes.STRING(64), allowNull: true },
    sku: { type: DataTypes.STRING(100), allowNull: true },
    barcode: { type: DataTypes.STRING(100), allowNull: true },
    size: { type: DataTypes.STRING(50), allowNull: true },
    color: { type: DataTypes.STRING(80), allowNull: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'product_variants', underscored: true }
);

Location.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    name: { type: DataTypes.STRING(150), allowNull: false },
    type: { type: DataTypes.STRING(20), allowNull: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'locations', underscored: true }
);

InventoryBalance.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    productVariantId: { type: DataTypes.UUID, allowNull: false },
    locationId: { type: DataTypes.UUID, allowNull: false },
    quantity: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE
  },
  { sequelize, tableName: 'inventory_balances', underscored: true }
);

InventoryMovement.init(
  {
    id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
    storeId: { type: DataTypes.UUID, allowNull: false },
    productVariantId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.STRING(20), allowNull: false },
    quantity: { type: DataTypes.INTEGER, allowNull: false },
    sourceLocationId: { type: DataTypes.UUID, allowNull: true },
    destinationLocationId: { type: DataTypes.UUID, allowNull: true },
    reference: { type: DataTypes.STRING(150), allowNull: true },
    notes: { type: DataTypes.TEXT, allowNull: true },
    createdAt: DataTypes.DATE
  },
  { sequelize, tableName: 'inventory_movements', underscored: true, updatedAt: false }
);

Store.hasMany(Product, { foreignKey: 'storeId', as: 'products' });
Product.belongsTo(Store, { foreignKey: 'storeId', as: 'store' });
Store.hasMany(Location, { foreignKey: 'storeId', as: 'locations' });
Location.belongsTo(Store, { foreignKey: 'storeId', as: 'store' });
Store.hasMany(StoreMembership, { foreignKey: 'storeId', as: 'memberships' });
StoreMembership.belongsTo(Store, { foreignKey: 'storeId', as: 'store' });
User.hasMany(StoreMembership, { foreignKey: 'userId', as: 'memberships' });
StoreMembership.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Store.hasOne(TiendanubeConnection, { foreignKey: 'storeId', as: 'tiendanubeConnection' });
TiendanubeConnection.belongsTo(Store, { foreignKey: 'storeId', as: 'store' });
Product.hasMany(ProductVariant, { foreignKey: 'productId', as: 'variants' });
ProductVariant.belongsTo(Product, { foreignKey: 'productId', as: 'product' });
ProductVariant.hasMany(InventoryBalance, { foreignKey: 'productVariantId', as: 'balances' });
InventoryBalance.belongsTo(ProductVariant, { foreignKey: 'productVariantId', as: 'variant' });
Location.hasMany(InventoryBalance, { foreignKey: 'locationId', as: 'balances' });
InventoryBalance.belongsTo(Location, { foreignKey: 'locationId', as: 'location' });
ProductVariant.hasMany(InventoryMovement, { foreignKey: 'productVariantId', as: 'movements' });
InventoryMovement.belongsTo(ProductVariant, { foreignKey: 'productVariantId', as: 'variant' });
Location.hasMany(InventoryMovement, { foreignKey: 'sourceLocationId', as: 'outgoingMovements' });
InventoryMovement.belongsTo(Location, { foreignKey: 'sourceLocationId', as: 'sourceLocation' });
Location.hasMany(InventoryMovement, { foreignKey: 'destinationLocationId', as: 'incomingMovements' });
InventoryMovement.belongsTo(Location, { foreignKey: 'destinationLocationId', as: 'destinationLocation' });
