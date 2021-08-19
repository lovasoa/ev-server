import global, { FilterParams } from '../../types/GlobalType';

import Constants from '../../utils/Constants';
import { DataResult } from '../../types/DataResult';
import DatabaseUtils from './DatabaseUtils';
import DbParams from '../../types/database/DbParams';
import Logging from '../../utils/Logging';
import PricingModel from '../../types/Pricing';
import Tenant from '../../types/Tenant';
import Utils from '../../utils/Utils';

const MODULE_NAME = 'PricingStorage';

export default class PricingStorage {

  public static async savePricingModel(tenant: Tenant, pricing: PricingModel): Promise<string> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenant.id, MODULE_NAME, 'savePricingModel');
    // Check Tenant
    DatabaseUtils.checkTenantObject(tenant);
    const pricingMDB = {
      _id: pricing.id,
      contextID: DatabaseUtils.convertToObjectID(pricing.contextID),
      pricingDefinitions: pricing.pricingDefinitions,
    };
    // Check Created/Last Changed By
    DatabaseUtils.addLastChangedCreatedProps(pricingMDB, pricing);
    // Save
    await global.database.getCollection<any>(tenant.id, 'pricingmodels').findOneAndUpdate(
      { '_id': pricing.id },
      { $set: pricingMDB },
      { upsert: true, returnDocument: 'after' });
    // Debug
    await Logging.traceEnd(tenant.id, MODULE_NAME, 'savePricingModel', uniqueTimerID, pricingMDB);
    return pricingMDB._id.toString();
  }

  public static async deletePricingModel(tenant: Tenant, pricingID: string): Promise<void> {
    // Debug
    const uniqueTimerID = Logging.traceStart(tenant.id, MODULE_NAME, 'deletePricing');
    // Check Tenant
    DatabaseUtils.checkTenantObject(tenant);
    // Delete
    await global.database.getCollection<any>(tenant.id, 'pricingmodels').deleteOne(
      {
        '_id': pricingID,
      }
    );
    // Debug
    await Logging.traceEnd(tenant.id, MODULE_NAME, 'deletePricingModel', uniqueTimerID, { id: pricingID });
  }

  public static async getPricingModel(tenant: Tenant, id: string,
      params: { contextIDs?: string[]; } = {}, projectFields?: string[]): Promise<PricingModel> {
    const pricingMDB = await PricingStorage.getPricingModels(tenant, {
      contextIDs: params.contextIDs,
    }, Constants.DB_PARAMS_SINGLE_RECORD, projectFields);
    return pricingMDB.count === 1 ? pricingMDB.result[0] : null;
  }

  public static async getPricingModels(tenant: Tenant,
      params: {
        contextIDs?: string[];
      },
      dbParams: DbParams, projectFields?: string[]): Promise<DataResult<PricingModel>> {
    const uniqueTimerID = Logging.traceStart(tenant.id, MODULE_NAME, 'getPricingModels');
    // Check Tenant
    DatabaseUtils.checkTenantObject(tenant);
    // Clone before updating the values
    dbParams = Utils.cloneObject(dbParams);
    // Check Limit
    dbParams.limit = Utils.checkRecordLimit(dbParams.limit);
    // Check Skip
    dbParams.skip = Utils.checkRecordSkip(dbParams.skip);
    // Create Aggregation
    const aggregation = [];
    const filters: FilterParams = {};
    // Remove deleted
    filters.deleted = { '$ne': true };
    // Limit records?
    if (!dbParams.onlyRecordCount) {
      // Always limit the nbr of record to avoid performances issues
      aggregation.push({ $limit: Constants.DB_RECORD_COUNT_CEIL });
    }
    // Count Records
    const pricingModelsCountMDB = await global.database.getCollection<any>(tenant.id, 'pricingmodels')
      .aggregate([...aggregation, { $count: 'count' }], { allowDiskUse: true })
      .toArray();
    // Check if only the total count is requested
    if (dbParams.onlyRecordCount) {
      // Return only the count
      await Logging.traceEnd(tenant.id, MODULE_NAME, 'getPricingModels', uniqueTimerID, pricingModelsCountMDB);
      return {
        count: (pricingModelsCountMDB.length > 0 ? pricingModelsCountMDB[0].count : 0),
        result: []
      };
    }
    // Remove the limit
    aggregation.pop();
    if (!dbParams.sort) {
      dbParams.sort = { createdOn: -1 };
    }
    aggregation.push({
      $sort: dbParams.sort
    });
    // Skip
    aggregation.push({
      $skip: dbParams.skip
    });
    // Limit
    aggregation.push({
      $limit: dbParams.limit
    });
    // Handle the ID
    DatabaseUtils.pushRenameDatabaseID(aggregation);
    // Convert Object ID to string
    DatabaseUtils.pushConvertObjectIDToString(aggregation, 'contextID');
    // Add Created By / Last Changed By
    DatabaseUtils.pushCreatedLastChangedInAggregation(tenant.id, aggregation);
    // Project
    DatabaseUtils.projectFields(aggregation, projectFields);
    // Read DB
    const pricingModelMDB = await global.database.getCollection<PricingModel>(tenant.id, 'pricingmodels')
      .aggregate(aggregation, {
        allowDiskUse: true
      })
      .toArray();
    // Debug
    await Logging.traceEnd(tenant.id, MODULE_NAME, 'getPricingModels', uniqueTimerID, pricingModelMDB);
    // Ok
    return {
      count: (pricingModelsCountMDB.length > 0 ?
        (pricingModelsCountMDB[0].count === Constants.DB_RECORD_COUNT_CEIL ? -1 : pricingModelsCountMDB[0].count) : 0),
      result: pricingModelMDB,
      projectedFields: projectFields
    };
  }
}
