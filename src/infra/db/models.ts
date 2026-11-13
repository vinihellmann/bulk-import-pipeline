import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
  type Sequelize,
} from 'sequelize';
import {
  IMPORT_FORMATS,
  IMPORT_STATUSES,
  type ImportFormat,
  type ImportStatus,
} from '../../modules/imports/domain/types';

export class ImportModel extends Model<
  InferAttributes<ImportModel>,
  InferCreationAttributes<ImportModel>
> {
  declare id: string;
  declare clientId: string;
  declare idempotencyKey: string;
  declare fileName: string;
  declare format: ImportFormat;
  declare fileSize: number | null;
  declare s3Key: string;
  declare runId: CreationOptional<string | null>;
  declare status: CreationOptional<ImportStatus>;
  declare totalRows: CreationOptional<number>;
  declare processedRows: CreationOptional<number>;
  declare failedRows: CreationOptional<number>;
  declare errorMessage: CreationOptional<string | null>;
  declare startedAt: CreationOptional<Date | null>;
  declare finishedAt: CreationOptional<Date | null>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export class ImportErrorModel extends Model<
  InferAttributes<ImportErrorModel>,
  InferCreationAttributes<ImportErrorModel>
> {
  declare id: CreationOptional<number>;
  declare importId: string;
  declare rowNumber: number;
  declare field: string;
  declare message: string;
}

export class ProductModel extends Model<
  InferAttributes<ProductModel>,
  InferCreationAttributes<ProductModel>
> {
  declare id: CreationOptional<number>;
  declare clientId: string;
  declare sku: string;
  declare name: string;
  declare description: string | null;
  declare price: number;
  declare stock: number;
  declare category: string;
  declare lastImportId: string | null;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;
}

export interface Models {
  ImportModel: typeof ImportModel;
  ImportErrorModel: typeof ImportErrorModel;
  ProductModel: typeof ProductModel;
}

/** Column names are snake_case in MySQL (`underscored: true`), attributes camelCase in code. */
export function initModels(sequelize: Sequelize): Models {
  ImportModel.init(
    {
      id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
      clientId: { type: DataTypes.STRING(64), allowNull: false, defaultValue: 'default' },
      idempotencyKey: { type: DataTypes.STRING(255), allowNull: false },
      fileName: { type: DataTypes.STRING(255), allowNull: false },
      format: { type: DataTypes.ENUM(...IMPORT_FORMATS), allowNull: false },
      // BIGINT comes back from mysql2 as a string; the repository converts it with Number.
      fileSize: { type: DataTypes.BIGINT.UNSIGNED, allowNull: true },
      s3Key: { type: DataTypes.STRING(512), allowNull: false },
      runId: { type: DataTypes.UUID, allowNull: true },
      status: {
        type: DataTypes.ENUM(...IMPORT_STATUSES),
        allowNull: false,
        defaultValue: 'AWAITING_UPLOAD',
      },
      totalRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      processedRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      failedRows: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      errorMessage: { type: DataTypes.TEXT, allowNull: true },
      startedAt: { type: DataTypes.DATE, allowNull: true },
      finishedAt: { type: DataTypes.DATE, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'imports', underscored: true },
  );

  ImportErrorModel.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      importId: { type: DataTypes.UUID, allowNull: false },
      rowNumber: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      field: { type: DataTypes.STRING(64), allowNull: false },
      message: { type: DataTypes.STRING(512), allowNull: false },
    },
    { sequelize, tableName: 'import_errors', underscored: true, timestamps: false },
  );

  ProductModel.init(
    {
      id: { type: DataTypes.BIGINT, autoIncrement: true, primaryKey: true },
      clientId: { type: DataTypes.STRING(64), allowNull: false },
      sku: { type: DataTypes.STRING(64), allowNull: false },
      name: { type: DataTypes.STRING(255), allowNull: false },
      description: { type: DataTypes.TEXT, allowNull: true },
      price: { type: DataTypes.DECIMAL(12, 2), allowNull: false },
      stock: { type: DataTypes.INTEGER, allowNull: false },
      category: { type: DataTypes.STRING(100), allowNull: false },
      lastImportId: { type: DataTypes.UUID, allowNull: true },
      createdAt: DataTypes.DATE,
      updatedAt: DataTypes.DATE,
    },
    { sequelize, tableName: 'products', underscored: true },
  );

  return { ImportModel, ImportErrorModel, ProductModel };
}
