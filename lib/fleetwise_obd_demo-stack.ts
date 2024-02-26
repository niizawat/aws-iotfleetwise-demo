import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  aws_s3 as s3,
  aws_iam as iam,
  aws_iotfleetwise as fleetwise,
  aws_timestream as timestream,
  aws_secretsmanager as secretsmanager,
} from "aws-cdk-lib";

export class FleetwiseObdDemoStack extends cdk.Stack {
  INTERFACE_ID = "1";
  THING_NAME = "fwdemo-rpi";

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // コンソールで作成したシグナルカタログ
    const signalCatalogArn = `arn:aws:iotfleetwise:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:signal-catalog/DefaultSignalCatalog`;

    // コンソールで作成した車両モデルOBD_II
    const modelManifestArn = `arn:aws:iotfleetwise:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:model-manifest/OBD_II`;

    // コンソールで作成したデコーダーマニフェスト
    const decoderManifestArn = `arn:aws:iotfleetwise:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:decoder-manifest/DefaultDecoderManifest`;

    const vehicle = new fleetwise.CfnVehicle(this, "Vehicle", {
      name: this.THING_NAME,
      decoderManifestArn: decoderManifestArn,
      modelManifestArn: modelManifestArn,
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
      signalCatalogArn: signalCatalogArn,
      signalsToCollect: [
        {
          name: "OBD.Speed",
        },
        {
          name: "OBD.EngineSpeed",
        },
        {
          name: "OBD.CoolantTemperature",
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

    const grafanaUser = new iam.User(this, "TimestreamReadOnlyUser", {
      userName: "grafana-user",
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonTimestreamReadOnlyAccess")],
    });
    const accessKey = new iam.AccessKey(this, "grafanaUserAccessKey", {
      user: grafanaUser,
    });
    const accessKeySecret = new secretsmanager.Secret(this, "GrafanaUserCredential", {
      secretName: "grafana-user-credential",
      secretObjectValue: {
        accessKeyId: cdk.SecretValue.unsafePlainText(accessKey.accessKeyId),
        secretAccessKey: accessKey.secretAccessKey,
      },
    });
    new cdk.CfnOutput(this, "GrafanaCredentialSecret", {
      key: "GrafanaCredentialSecret",
      value: accessKeySecret.secretArn,
    });
  }
}
