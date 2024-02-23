import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import { aws_s3 as s3, aws_iam as iam, aws_iotfleetwise as fleetwise, aws_timestream as timestream } from "aws-cdk-lib";
import { CfnDecoderManifest, CfnModelManifest } from "aws-cdk-lib/aws-iotfleetwise";

export class FleetwiseDemoStack extends cdk.Stack {
  INTERFACE_ID = "1";
  THING_NAME = "fwdemo-rpi";

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const signalCatalog = new fleetwise.CfnSignalCatalog(this, "SignalCatalog", {
      name: "catalog",
      description: "LEGO Car Signal Catalog",
      nodes: [
        {
          branch: {
            fullyQualifiedName: "Vehicle",
          },
        },
        {
          branch: {
            fullyQualifiedName: "Vehicle.Body",
          },
        },
        {
          branch: {
            fullyQualifiedName: "Vehicle.Body.Lights",
          },
        },
        {
          branch: {
            fullyQualifiedName: "Vehicle.Body.Lights.Beam",
          },
        },
        {
          branch: {
            fullyQualifiedName: "Vehicle.Body.Lights.Beam.Low",
          },
        },
        {
          actuator: {
            fullyQualifiedName: "Vehicle.Body.Lights.Beam.Low.IsOn",
            dataType: "BOOLEAN",
          },
        },
        {
          branch: {
            fullyQualifiedName: "Vehicle.Exterior",
          },
        },
        {
          sensor: {
            fullyQualifiedName: "Vehicle.Exterior.LightIntensity",
            dataType: "FLOAT",
            unit: "percent",
            min: 0,
            max: 100,
            description: "Light intensity as a percent. 0 = No light detected, 100 = Fully lit.",
          },
        },
      ],
    });

    const modelManifest = new CfnModelManifest(this, "ModelManifest", {
      name: "model-manifest",
      status: "ACTIVE",
      nodes: ["Vehicle.Body.Lights.Beam.Low.IsOn", "Vehicle.Exterior.LightIntensity"],
      signalCatalogArn: signalCatalog.attrArn,
    });

    const decoderManifest = new CfnDecoderManifest(this, "DecoderManifest", {
      name: "decoder-manifest-001",
      status: "ACTIVE",
      modelManifestArn: modelManifest.attrArn,
      networkInterfaces: [
        {
          interfaceId: this.INTERFACE_ID,
          type: "CAN_INTERFACE",
          canInterface: {
            name: "can0",
            protocolName: "CAN",
          },
        },
      ],
      signalDecoders: [
        {
          interfaceId: this.INTERFACE_ID,
          type: "CAN_SIGNAL",
          fullyQualifiedName: "Vehicle.Exterior.LightIntensity",
          canSignal: {
            name: "Light_Intensity",
            messageId: "1",
            isBigEndian: "false",
            isSigned: "false",
            startBit: "0",
            length: "16",
            factor: "0.01",
            offset: "0",
          },
        },
        {
          interfaceId: this.INTERFACE_ID,
          type: "CAN_SIGNAL",
          fullyQualifiedName: "Vehicle.Body.Lights.Beam.Low.IsOn",
          canSignal: {
            name: "Light_Low_IsOn",
            messageId: "2",
            isBigEndian: "false",
            isSigned: "false",
            startBit: "0",
            length: "1",
            factor: "1",
            offset: "0",
          },
        },
      ],
    });

    const vehicle = new fleetwise.CfnVehicle(this, "Vehicle", {
      name: this.THING_NAME,
      decoderManifestArn: decoderManifest.attrArn,
      modelManifestArn: modelManifest.attrArn,
      associationBehavior: "ValidateIotThingExists",
    });

    const bucket = new s3.Bucket(this, "Bucket", {
      autoDeleteObjects: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const timestreamDb = new timestream.CfnDatabase(this, "TimestreamDb", {
      databaseName: "fleetwisedb",
    });
    const timestreamTable = new timestream.CfnTable(this, "TimestreamTable", {
      databaseName: timestreamDb.databaseName!,
      tableName: "campaign",
      retentionProperties: {
        MemoryStoreRetentionPeriodInHours: 24,
        MagneticStoreRetentionPeriodInDays: 7,
      },
    });
    timestreamTable.addDependsOn(timestreamDb);

    const role = new iam.Role(this, "TimestreamExecutionRole", {
      roleName: "TimestreamExecutionRole",
      description: "Timestream Execution Role",
      assumedBy: new iam.ServicePrincipal("iotfleetwise.amazonaws.com"),
      inlinePolicies: {
        TimestreamTrustPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["timestream:WriteRecords", "timestream:Select", "timestream:DescribeTable"],
              resources: [
                `arn:aws:timestream:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:database/${timestreamDb.databaseName}/table/${timestreamTable.tableName}`,
              ],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["timestream:DescribeEndpoints"],
              resources: ["*"],
            }),
          ],
        }),
        S3BucketTrustPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:ListBucket"],
              resources: [bucket.bucketArn],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["s3:GetObject", "s3:PutObject"],
              resources: [bucket.arnForObjects("*")],
            }),
          ],
        }),
        LogTrustPolicy: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: ["iotfleetwise:PutLoggingOptions", "iotfleetwise:GetLoggingOptions"],
              resources: ["*"],
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              actions: [
                "logs:CreateLogDelivery",
                "logs:GetLogDelivery",
                "logs:UpdateLogDelivery",
                "logs:DeleteLogDelivery",
                "logs:ListLogDeliveries",
                "logs:PutResourcePolicy",
                "logs:DescribeResourcePolicies",
                "logs:DescribeLogGroups",
              ],
              resources: ["*"],
            }),
          ],
        }),
      },
    });

    const campaign = new fleetwise.CfnCampaign(this, "Campaign", {
      name: "TimeBasedCampaign001",
      action: "APPROVE",
      priority: 0,
      targetArn: vehicle.attrArn,
      collectionScheme: {
        timeBasedCollectionScheme: {
          periodMs: 10000,
        },
      },
      signalCatalogArn: signalCatalog.attrArn,
      signalsToCollect: [
        {
          name: "Vehicle.Body.Lights.Beam.Low.IsOn",
        },
        {
          name: "Vehicle.Exterior.LightIntensity",
        },
      ],
      spoolingMode: "TO_DISK",
      diagnosticsMode: "SEND_ACTIVE_DTCS",
      dataDestinationConfigs: [
        {
          timestreamConfig: {
            timestreamTableArn: `arn:aws:timestream:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:database/${timestreamDb.databaseName}/table/${timestreamTable.tableName}`,
            executionRoleArn: role.roleArn,
          },
          // s3Config: {
          //   bucketArn: bucket.bucketArn,
          //   dataFormat: "JSON",
          //   prefix: "TimeBasedCampain",
          // },
        },
      ],
    });

    // https://docs.aws.amazon.com/ja_jp/iot-fleetwise/latest/developerguide/controlling-access.html
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("iotfleetwise.amazonaws.com")],
        actions: ["s3:ListBucket"],
        resources: [bucket.bucketArn],
      })
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal("iotfleetwise.amazonaws.com")],
        actions: ["s3:GetObject", "s3:PutObject"],
        resources: [bucket.arnForObjects("*")],
        conditions: {
          StringEquals: {
            "aws:SourceArn": `arn:${cdk.Aws.PARTITION}:iotfleetwise:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:campaign/${campaign.name}`,
            "aws:SourceAccount": cdk.Aws.ACCOUNT_ID,
          },
        },
      })
    );
  }
}
