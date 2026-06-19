---
title: Supply Chain Domain Pack
created: 2026-06-18
last_updated: 2026-06-18
type: feature
status: active
related_components:
  - ontology-engine
  - actions
  - security
  - sync-engine
  - api
related_decisions: []
---

# Supply Chain Domain Pack

The supply chain control tower domain pack (`supply.chain`, v0.1.0) provides end-to-end visibility, disruption management, and inventory optimization across product, supplier, facility, and order networks. It models the physical flow of goods from purchase order through shipment to receipt, with inventory tracking at facilities.

## Scope

### Object Types (6)

| Type | Description |
|------|-------------|
| **Product** | Catalog item. Fields: `id`, `sku` (unique), `name` (searchable), `category`, `unitOfMeasure`, `reorderPoint` (>=0), `reorderQuantity` (>0). Linked to Supplier via `SuppliesProduct` (inbound). |
| **Supplier** | Vendor/provider. Fields: `id`, `name` (searchable), `code` (unique), `tier` (SupplierTier), `contactName`, `contactEmail` (sensitive), `country`, `leadTimeDays` (>=0), `onTimeDeliveryRate`. Linked to Product via `SuppliesProduct` (outbound). |
| **Shipment** | Goods in transit. Fields: `id`, `trackingNumber` (unique), `status` (ShipmentStatus), `transportMode`, `quantity` (>0), `departureDate`, `estimatedArrival`, `actualArrival`, `order` (FK), `origin` (FK), `destination` (FK). |
| **Facility** | Warehouse/distribution centre. Fields: `id`, `name` (searchable), `code` (unique), `type` (FacilityType), `status` (FacilityStatus), `address`, `country`, `capacity` (>0), `currentUtilization` (computed from InventoryAt links). |
| **InventoryRecord** | Stock at a facility. Fields: `id`, `quantity` (>=0), `reservedQuantity` (>=0), `stockLevel` (StockLevel), `lastCountDate`, `product` (FK), `facility` (FK). |
| **PurchaseOrder** | Order to supplier. Fields: `id`, `orderNumber` (unique, immutable), `status` (OrderStatus), `supplier` (FK), `product` (FK), `quantity` (>0), `unitCost` (>0), `currency`, `requestedDeliveryDate`, `notes`. |

### Link Types (7)

| Link | From | To | Cardinality | Notes |
|------|------|----|-------------|-------|
| `SuppliesProduct` | Supplier | Product | MANY_TO_MANY | Active link with commercial terms: `leadTimeDays`, `unitCost`, `minOrderQuantity`, `preferredSupplier` |
| `OrderedFrom` | PurchaseOrder | Supplier | MANY_TO_ONE | Implicit reference (FK on PurchaseOrder.supplier); `orderedAt` |
| `ShipmentForOrder` | Shipment | PurchaseOrder | MANY_TO_ONE | Implicit reference (FK on Shipment.order) |
| `ShipsFrom` | Shipment | Facility | MANY_TO_ONE | Implicit reference (FK on Shipment.origin) |
| `ShipsTo` | Shipment | Facility | MANY_TO_ONE | Implicit reference (FK on Shipment.destination) |
| `InventoryAt` | InventoryRecord | Facility | MANY_TO_ONE | Implicit reference (FK on InventoryRecord.facility) |
| `InventoryOf` | InventoryRecord | Product | MANY_TO_ONE | Implicit reference (FK on InventoryRecord.product) |

### Actions (4)

| Action | Description | Key Params |
|--------|-------------|------------|
| `CreateOrder` | Create a purchase order with a supplier for a product | supplier, product, orderNumber, quantity, unitCost, currency, requestedDeliveryDate, notes? |
| `ShipOrder` | Dispatch a shipment for a purchase order from origin to destination | order, origin, destination, trackingNumber?, transportMode, estimatedArrival? |
| `ReceiveShipment` | Receive a shipment at a destination facility, updating inventory | shipment, order, destination, product?, inventoryRecord?, receivedQuantity, stockLevel |
| `CancelOrder` | Cancel a purchase order with optional reason | order, reason? |

## Implementation

The pack is composed of:
- **8 ODL schemas**: `enums.odl`, `supplier.odl`, `facility.odl`, `product.odl`, `purchase-order.odl`, `shipment.odl`, `inventory-record.odl`, `links.odl`, `actions.odl`
- **4 action manifests**: YAML files with CEL preconditions/effects for order/ship/cancel/receive operations
- **Permissions**: `supply-chain-roles.fga` — OpenFGA authorization model for procurement, logistics, and inventory roles
- **Tests**: `src/__tests__/supply-chain-pack.test.ts`

The workflow follows the physical supply chain: CreateOrder → ShipOrder → ReceiveShipment (cancel at any point before shipping). `ReceiveShipment` is the richest action, updating shipment status, order status, and inventory records atomically.

Six of seven link types are **implicit reference links** — foreign keys stored directly on child objects. Only `SuppliesProduct` is actively managed, with commercial terms (lead time, unit cost, minimum order quantity).

## Connectors

### ERP_Products (JDBC)

- **Datasource**: `ERP_Products` — connects to enterprise ERP system (SAP S/4HANA, Oracle EBS, etc.)
- **Connector type**: `jdbc`
- **Sync mode**: `OVERLAY` with TTL cache (PT15M)
- **Writeback**: disabled (`writeback: false`)
- **Mapping**: `material_master` table → `Product` object type. Transforms `material_id` to prefixed `product-{id}`, maps material numbers, descriptions, groups, units of measure, and reorder points/quantities
- **Future**: CDC mode deferred post-MVP

## Status & Roadmap

- **Current**: Active. Full schema, actions, and JDBC connector implemented (v0.1.0).
- **v0.1.0**: Initial version with 6 object types, 7 link types, 4 actions, 1 connector
- **Pending**: CDC sync mode for real-time inventory; additional connectors for WMS (warehouse management), TMS (transportation), and supplier portals; multi-echelon inventory optimization logic

## Sources

- [Source: domain-packs/supply-chain/pack.yaml]
- [Source: domain-packs/supply-chain/schema/ — all ODL schemas]
- [Source: domain-packs/supply-chain/actions/ — action manifests]
- [Source: domain-packs/supply-chain/connectors/erp-jdbc.yaml]
- [Source: domain-packs/supply-chain/permissions/supply-chain-roles.fga]
