import { AggregateOptions, ObjectId } from 'mongodb';
import { ChargePointStatus, OCPPFirmwareStatus } from '../../types/ocpp/OCPPServer';

import BackendError from '../../exception/BackendError';
import Configuration from '../../utils/Configuration';
import Constants from '../../utils/Constants';
import { DatabaseCount } from '../../types/GlobalType';
import DbLookup from '../../types/database/DbLookup';
import Tenant from '../../types/Tenant';
import User from '../../types/User';
import UserToken from '../../types/UserToken';
import Utils from '../../utils/Utils';

const FIXED_COLLECTIONS: string[] = ['tenants', 'migrations'];

const MODULE_NAME = 'DatabaseUtils';

export default class DatabaseUtils {
  public static readonly MONGO_USER_MASK = Object.freeze({
    '_id': 0,
    '__v': 0,
    'email': 0,
    'phone': 0,
    'mobile': 0,
    'notificationsActive': 0,
    'notifications': 0,
    'iNumber': 0,
    'costCenter': 0,
    'status': 0,
    'createdBy': 0,
    'createdOn': 0,
    'lastChangedBy': 0,
    'lastChangedOn': 0,
    'role': 0,
    'password': 0,
    'locale': 0,
    'passwordWrongNbrTrials': 0,
    'passwordBlockedUntil': 0,
    'passwordResetHash': 0,
    'eulaAcceptedOn': 0,
    'eulaAcceptedVersion': 0,
    'eulaAcceptedHash': 0,
    'image': 0,
    'address': 0,
    'plateID': 0,
    'verificationToken': 0,
    'mobileLastChangedOn': 0,
    'issuer': 0,
    'mobileOs': 0,
    'mobileToken': 0,
    'verifiedAt': 0,
    'importedData': 0,
    'billingData': 0
  });

  public static addConnectorStatsInOrg(tenant: Tenant, aggregation: any[],
      organizationID: string, addChargingStationLookup = true): void {
    if (addChargingStationLookup) {
      DatabaseUtils.pushChargingStationLookupInAggregation({
        tenantID: tenant.id, aggregation, localField: '_id', foreignField: organizationID,
        asField: 'chargingStations' });
    }
    // Unwind Charging Stations and Connectors
    aggregation.push(
      { $unwind: { path: '$chargingStations', preserveNullAndEmptyArrays: true } },
      { $unwind: { path: '$chargingStations.connectors', preserveNullAndEmptyArrays: true } }
    );
    // Add Status fields
    DatabaseUtils.addConnectorStatusFields(aggregation);
    // Group back Connectors
    DatabaseUtils.groupBackToArray(aggregation, 'chargingStations.connectors', 'chargingStations.id',
      DatabaseUtils.getConnectorStatusAggregationFields(), 'connectorStats');
    // Group back Charging Stations
    DatabaseUtils.groupBackToArray(aggregation, 'chargingStations', 'id',
      DatabaseUtils.getConnectorStatusAggregationFields(), 'connectorStats');
  }

  public static addConnectorStatusFields(aggregation: any[]): void {
    DatabaseUtils.addConnectorStatusField(aggregation, 'availableConnectors', ChargePointStatus.AVAILABLE);
    DatabaseUtils.addConnectorStatusField(aggregation, 'unavailableConnectors', ChargePointStatus.UNAVAILABLE);
    DatabaseUtils.addConnectorStatusField(aggregation, 'preparingConnectors', ChargePointStatus.PREPARING);
    DatabaseUtils.addConnectorStatusField(aggregation, 'finishingConnectors', ChargePointStatus.FINISHING);
    DatabaseUtils.addConnectorStatusField(aggregation, 'faultedConnectors', ChargePointStatus.FAULTED);
    DatabaseUtils.addConnectorStatusesField(aggregation, 'chargingConnectors', [ChargePointStatus.CHARGING, ChargePointStatus.OCCUPIED]);
    DatabaseUtils.addConnectorStatusesField(aggregation, 'suspendedConnectors', [ChargePointStatus.SUSPENDED_EVSE, ChargePointStatus.SUSPENDED_EV]);
    aggregation.push({
      $addFields: {
        'connectors.totalConnectors' : {
          $cond : {
            if : { $gt : [ '$chargingStations.connectors', null ] },
            then : 1, else : 0
          }
        }
      }
    });
  }

  public static getConnectorStatusAggregationFields(): Record<string, any> {
    return {
      totalConnectors : { $sum : '$connectors.totalConnectors' },
      unavailableConnectors : { $sum : '$connectors.unavailableConnectors' },
      chargingConnectors : { $sum : '$connectors.chargingConnectors' },
      suspendedConnectors : { $sum : '$connectors.suspendedConnectors' },
      availableConnectors : { $sum : '$connectors.availableConnectors' },
      faultedConnectors : { $sum : '$connectors.faultedConnectors' },
      preparingConnectors : { $sum : '$connectors.preparingConnectors' },
      finishingConnectors : { $sum : '$connectors.finishingConnectors' },
    };
  }

  public static addConnectorStatusField(aggregation: any[], fieldName: string, connectorStatus: ChargePointStatus): void {
    aggregation.push({
      $addFields: {
        [`connectors.${fieldName}`]: {
          $cond: {
            if: { $eq: ['$chargingStations.connectors.status', connectorStatus] },
            then: 1, else: 0
          }
        }
      }
    });
  }

  public static addConnectorStatusesField(aggregation: any[], fieldName: string, connectorStatuses: ChargePointStatus[]): void {
    aggregation.push({
      $addFields: {
        [`connectors.${fieldName}`]: {
          $cond: {
            if : {
              $or : connectorStatuses.map((connectorStatus) =>
                ({ $eq: ['$chargingStations.connectors.status', connectorStatus] }))
            },
            then: 1, else: 0
          }
        }
      }
    });
  }

  public static getCountFromDatabaseCount(databaseCount: DatabaseCount): number {
    if (databaseCount) {
      if (databaseCount.count === Constants.DB_RECORD_COUNT_CEIL) {
        return -1;
      }
      return databaseCount.count;
    }
    return 0;
  }

  public static isObjectID(id: string): boolean {
    if (ObjectId.isValid(id)) {
      if (new ObjectId(id).toString() === id) {
        return true;
      }
    }
    return false;
  }

  public static buildAggregateOptions(): AggregateOptions {
    return { allowDiskUse: true };
  }

  public static getFixedCollections(): string[] {
    return FIXED_COLLECTIONS;
  }

  public static pushCreatedLastChangedInAggregation(tenantID: string, aggregation: any[]): void {
    // Add Created By
    DatabaseUtils.pushUserInAggregation(tenantID, aggregation, 'createdBy');
    // Add Last Changed By
    DatabaseUtils.pushUserInAggregation(tenantID, aggregation, 'lastChangedBy');
  }

  public static getCollectionName(tenantID: string, collectionNameSuffix: string): string {
    let prefix = Constants.DEFAULT_TENANT_ID;
    if (!FIXED_COLLECTIONS.includes(collectionNameSuffix) && DatabaseUtils.isObjectID(tenantID)) {
      prefix = tenantID;
    }
    return `${prefix}.${collectionNameSuffix}`;
  }

  public static pushSiteLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('sites', {
      objectIDFields: ['companyID', 'createdBy', 'lastChangedBy'],
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushCarCatalogLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('carcatalogs', {
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushCarLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('cars', {
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushSiteUserLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('siteusers', {
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushTransactionsLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('transactions', {
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushUserLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('users', {
      objectIDFields: ['createdBy', 'lastChangedBy'],
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushCompanyLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('companies', {
      objectIDFields: ['createdBy', 'lastChangedBy'],
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushSiteAreaLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('siteareas', {
      objectIDFields: ['createdBy', 'lastChangedBy'],
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushChargingStationLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('chargingstations', {
      objectIDFields: ['createdBy', 'lastChangedBy'],
      ...lookupParams
    }, [DatabaseUtils.buildChargingStationInactiveFlagQuery(), ...additionalPipeline]);
  }

  public static pushAssetLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('assets', {
      objectIDFields: ['createdBy', 'lastChangedBy'],
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushTagLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('tags', {
      objectIDFields: ['createdBy', 'lastChangedBy'],
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushTenantLogoLookupInAggregation(lookupParams: DbLookup, additionalPipeline: Record<string, any>[] = []): void {
    DatabaseUtils.pushCollectionLookupInAggregation('tenantlogos', {
      ...lookupParams
    }, additionalPipeline);
  }

  public static pushArrayFilterInAggregation(aggregation: any[], arrayName: string, filter: Record<string, any>): void {
    // Unwind the array
    aggregation.push({ '$unwind': { path: `$${arrayName}`, preserveNullAndEmptyArrays: true } });
    // Filter
    aggregation.push({ '$match': filter });
    // Group back
    DatabaseUtils.groupBackToArray(aggregation, arrayName);
  }

  public static push2ArraysFilterInAggregation(aggregation: any[], firstArrayName: string,
      firstArrayPropertyID: string, secondArrayName: string, filter: Record<string, any>): void {
    // Unwind first array
    aggregation.push({ '$unwind': { path: `$${firstArrayName}`, preserveNullAndEmptyArrays: true } });
    // Unwind second array
    aggregation.push({ '$unwind': { path: `$${secondArrayName}`, preserveNullAndEmptyArrays: true } });
    // Filter
    aggregation.push({ '$match': filter });
    // Group back second array
    DatabaseUtils.groupBackToArray(aggregation, secondArrayName, firstArrayPropertyID);
    // Group back first array
    DatabaseUtils.groupBackToArray(aggregation, firstArrayName);
  }

  public static pushArrayLookupInAggregation(arrayName: string,
      lookupMethod: (lookupParams: DbLookup, additionalPipeline?: Record<string, any>[]) => void,
      lookupParams: DbLookup, additionalParams: { pipeline?: Record<string, any>[], sort?: any } = {}): void {
    // Unwind the source
    lookupParams.aggregation.push({ '$unwind': { path: `$${arrayName}`, preserveNullAndEmptyArrays: true } });
    // Call the lookup
    lookupMethod(lookupParams);
    // Add external pipeline
    if (!Utils.isEmptyArray(additionalParams.pipeline)) {
      lookupParams.aggregation.push(...additionalParams.pipeline);
    }
    // Sort (for unwinded array props)
    if (additionalParams.sort) {
      lookupParams.aggregation.push({
        $sort: additionalParams.sort
      });
    }
    // Group back tp array
    DatabaseUtils.groupBackToArray(lookupParams.aggregation, arrayName);
    // Sort again (after grouping, sort is lost)
    if (additionalParams.sort) {
      lookupParams.aggregation.push({
        $sort: additionalParams.sort
      });
    }
  }

  public static pushCollectionLookupInAggregation(collection: string, lookupParams: DbLookup, additionalPipeline?: Record<string, any>[]): void {
    // Build Lookup's pipeline
    if (!lookupParams.pipelineMatch) {
      lookupParams.pipelineMatch = {};
    }
    lookupParams.pipelineMatch['$expr'] = { '$eq': [`$${lookupParams.foreignField}`, '$$fieldVar'] };
    const pipeline: any[] = [
      { '$match': lookupParams.pipelineMatch }
    ];
    if (!Utils.isEmptyArray(additionalPipeline)) {
      pipeline.push(...additionalPipeline);
    }
    if (lookupParams.count) {
      pipeline.push({
        '$group': {
          '_id': `$${lookupParams.asField}`,
          'count': { '$sum': 1 }
        }
      });
    }
    // Replace ID field
    DatabaseUtils.pushRenameDatabaseID(pipeline);
    // Convert ObjectId fields to String
    if (lookupParams.objectIDFields) {
      for (const foreignField of lookupParams.objectIDFields) {
        DatabaseUtils.pushConvertObjectIDToString(pipeline, foreignField);
      }
    }
    // Add Projected fields
    DatabaseUtils.projectFields(pipeline, lookupParams.projectFields);
    // Create Lookup
    lookupParams.aggregation.push({
      $lookup: {
        from: DatabaseUtils.getCollectionName(lookupParams.tenantID, collection),
        'let': { 'fieldVar': `$${lookupParams.localField}` },
        pipeline,
        'as': lookupParams.asField
      }
    });
    // One record?
    if (lookupParams.oneToOneCardinality) {
      lookupParams.aggregation.push({
        $unwind: {
          path: `$${lookupParams.asField}`,
          preserveNullAndEmptyArrays: !lookupParams.oneToOneCardinalityNotNull
        }
      });
    }
    // Check if the target field is a composed property: empty root document must be null ({} = null)
    const splitAsField = lookupParams.asField.split('.');
    if (splitAsField.length > 1) {
      lookupParams.aggregation.push(JSON.parse(`{
        "$addFields": {
          "${splitAsField[0]}": {
            "$cond": {
              "if": { "$eq": [ "$${splitAsField[0]}", ${lookupParams.oneToOneCardinality ? '{}' : '[]'} ] },
              "then": null, "else": "$${splitAsField[0]}" }
          }
        }
      }`));
    }
    // Set only the count
    if (lookupParams.count) {
      lookupParams.aggregation.push({
        $unwind: {
          path: `$${lookupParams.asField}`,
          preserveNullAndEmptyArrays: true
        }
      });
      lookupParams.aggregation.push(JSON.parse(`{
        "$addFields": {
          "${lookupParams.asField}": "$${lookupParams.asField}.count"
        }
      }`));
    }
  }

  public static pushChargingStationInactiveFlag(aggregation: any[]): void {
    // Add inactive field
    aggregation.push(DatabaseUtils.buildChargingStationInactiveFlagQuery());
  }

  public static projectFields(aggregation: any[], projectFields: string[], removedFields: string[] = []): void {
    if (!Utils.isEmptyArray(projectFields)) {
      const project = {
        $project: {}
      };
      for (const projectedField of projectFields) {
        project.$project[projectedField] = 1;
      }
      for (const removedField of removedFields) {
        project.$project[removedField] = 0;
      }
      aggregation.push(project);
    }
  }

  public static pushConvertObjectIDToString(aggregation: any[], fieldName: string, renamedFieldName?: string): void {
    if (!renamedFieldName) {
      renamedFieldName = fieldName;
    }
    // Make sure the field exists so it can be operated on
    aggregation.push(JSON.parse(`{
      "$addFields": {
        "${renamedFieldName}": {
          "$ifNull": ["$${fieldName}", null]
        }
      }
    }`));
    // Convert to string (or null)
    aggregation.push(JSON.parse(`{
      "$addFields": {
        "${renamedFieldName}": {
          "$cond": { "if": { "$gt": ["$${fieldName}", null] }, "then": { "$toString": "$${fieldName}" }, "else": null }
        }
      }
    }`));
    // Check if the field is a composed property: empty root document must be null ({} = null)
    const splitFieldName = renamedFieldName.split('.');
    if (splitFieldName.length === 2) {
      aggregation.push(JSON.parse(`{
        "$addFields": {
          "${splitFieldName[0]}": {
            "$cond": {
              "if": { "$eq": [ "$${splitFieldName[0]}", { "${splitFieldName[1]}": null } ] },
              "then": null, "else": "$${splitFieldName[0]}" }
          }
        }
      }`));
    }
  }

  public static clearFieldValueIfSubFieldIsNull(aggregation: any[], fieldName: string, subFieldName: string): void {
    // Remove if null
    const addNullFields: any = {};
    addNullFields[`${fieldName}`] = {
      $cond: {
        if: { $gt: [`$${fieldName}.${subFieldName}`, null] },
        then: `$${fieldName}`,
        else: null
      }
    };
    aggregation.push({ $addFields: addNullFields });
  }

  public static pushRenameField(aggregation: any[], fieldName: string, renamedFieldName: string): void {
    // Rename
    aggregation.push(JSON.parse(`{
      "$addFields": {
        "${renamedFieldName}": "$${fieldName}"
      }
    }`));
    // Delete
    aggregation.push(JSON.parse(`{
      "$project": {
        "${fieldName}": 0
      }
    }`));
  }

  public static pushRenameDatabaseIDToNumber(aggregation: any[]): void {
    // Rename ID
    DatabaseUtils.pushRenameField(aggregation, '_id', 'id');
  }

  public static addLastChangedCreatedProps(dest: any, entity: any): void {
    dest.createdBy = entity.createdBy ? DatabaseUtils.mongoConvertUserID(entity, 'createdBy') : null;
    dest.createdOn = entity.createdOn ? Utils.convertToDate(entity.createdOn) : null;
    dest.lastChangedBy = entity.lastChangedBy ? DatabaseUtils.mongoConvertUserID(entity, 'lastChangedBy') : null;
    dest.lastChangedOn = entity.lastChangedOn ? Utils.convertToDate(entity.lastChangedOn) : null;
  }

  public static pushRenameDatabaseID(aggregation: any[], nestedField?: string): void {
    // Root document?
    if (!nestedField) {
      // Convert ID to string
      DatabaseUtils.pushConvertObjectIDToString(aggregation, '_id', 'id');
      // Remove IDs
      aggregation.push({
        $project: {
          '_id': 0,
          '__v': 0
        }
      });
    } else {
      // Convert ID to string
      DatabaseUtils.pushConvertObjectIDToString(
        aggregation, `${nestedField}._id`, `${nestedField}.id`);
      // Remove IDs
      const project = {
        $project: {}
      };
      project.$project[nestedField] = {
        '__v': 0,
        '_id': 0
      };
      aggregation.push(project);
    }
  }

  public static convertToObjectID(id: string): ObjectId {
    if (id) {
      return new ObjectId(id);
    }
  }

  public static generateID(): string {
    return new ObjectId().toString();
  }

  public static convertUserToObjectID(user: User | UserToken | string): ObjectId | null {
    let userID: ObjectId | null = null;
    // Check Created By
    if (user) {
      // Check User Model
      if (typeof user === 'object' &&
        user.constructor.name !== 'ObjectId') {
        // This is the User Model
        userID = DatabaseUtils.convertToObjectID(user.id);
      }
      // Check String
      if (typeof user === 'string') {
        // This is a String
        userID = DatabaseUtils.convertToObjectID(user);
      }
    }
    return userID;
  }

  public static checkTenantObject(tenant: Tenant): void {
    if (!tenant) {
      throw new BackendError({
        module: MODULE_NAME,
        method: 'checkTenantObject',
        message: 'Invalid Tenant'
      });
    }
  }

  public static groupBackToArray(aggregation: any[], arrayName: string, arrayPropertyID = 'id',
      groupAggregation: Record<string, any> = {}, rootAggregationName = ''): void {
    // Keep the prop as variable in the query (eg. keep 'connectors' as var instead fo 'chargingStations.connectors' which is invalid in MongoDB )
    const arrayVariableNames = arrayName.split('.');
    const arrayVariableName = arrayVariableNames[arrayVariableNames.length - 1];
    // Group back to arrays
    aggregation.push({
      $group: {
        '_id': {
          '_id': '$_id',
          id: `$${arrayPropertyID}`
        },
        root: { $first: '$$ROOT' },
        [`${arrayVariableName}`]: { $push: `$${arrayName}` },
        ...groupAggregation
      }
    });
    // Replace Array
    aggregation.push({
      $addFields: {
        [`root.${arrayName}`]: {
          $cond: {
            if: {
              $or: [
                { $eq: [ `$${arrayVariableName}`, [{}] ] },
                { $eq: [ `$${arrayVariableName}`, [null] ] }
              ]
            },
            then: [],
            else: `$${arrayVariableName}`
          }
        }
      }
    });
    // Replace Aggregation
    if (groupAggregation && rootAggregationName) {
      // Build aggregated fileds
      const aggregatedFields = Object.keys(groupAggregation).reduce((previousValue: Record<string,any>, key: string) =>
        ({
          ...previousValue,
          [`root.${rootAggregationName}.${key}`]:`$${key}`
        }), {});
      // Add
      aggregation.push({
        $addFields: aggregatedFields
      });
    }
    // Replace root
    aggregation.push({ $replaceRoot: { newRoot: '$root' } });
  }

  private static buildChargingStationInactiveFlagQuery(): Record<string, any> {
    // Add inactive field
    return {
      $addFields: {
        inactive: {
          $or: [
            { $eq: ['$firmwareUpdateStatus', OCPPFirmwareStatus.INSTALLING] },
            {
              $gte: [
                { $subtract: [new Date(), '$lastSeen'] },
                Configuration.getChargingStationConfig().pingIntervalOCPPJSecs * 2 * 1000
              ]
            }
          ]
        }
      }
    };
  }

  // Temporary hack to fix user Id saving. fix all this when user is typed...
  private static mongoConvertUserID(obj: any, prop: string): ObjectId | null {
    if (!obj || !obj[prop]) {
      return null;
    }
    if (DatabaseUtils.isObjectID(obj[prop])) {
      return obj[prop] as ObjectId;
    }
    if (obj[prop].id) {
      return DatabaseUtils.convertToObjectID(obj[prop].id);
    }
    return null;
  }

  private static pushUserInAggregation(tenantID: string, aggregation: any[], fieldName: string) {
    // Created By Lookup
    aggregation.push({
      $lookup: {
        from: DatabaseUtils.getCollectionName(tenantID, 'users'),
        localField: fieldName,
        foreignField: '_id',
        as: fieldName
      }
    });
    // Single Record
    aggregation.push({
      $unwind: { 'path': `$${fieldName}`, 'preserveNullAndEmptyArrays': true }
    });
    // Replace nested ID field
    DatabaseUtils.pushRenameDatabaseID(aggregation, fieldName);
    // Handle null
    const addNullFields: any = {};
    addNullFields[`${fieldName}`] = {
      $cond: {
        if: { $gt: [`$${fieldName}.id`, null] },
        then: `$${fieldName}`,
        else: null
      }
    };
    aggregation.push({ $addFields: addNullFields });
    // Project
    const projectFields: any = {};
    projectFields[`${fieldName}`] = DatabaseUtils.MONGO_USER_MASK;
    aggregation.push({
      $project: projectFields
    });
  }
}
