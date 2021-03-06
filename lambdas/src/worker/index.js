const AWS = require("aws-sdk")

const createLighthouse = require("./create-lighthouse.js")
const fs = require("fs")

AWS.config.update({ region: process.env.REGION })

const ddb = new AWS.DynamoDb.DocumentClient()
const s3 = new AWS.S3()

async function updateJobItemAndCreateRunItem(jobId, jobAttrToIncrement, runId, runUrl, json, runError) {
  const updateJob = {
    TableName: process.env.JOBS_TABLE_NAME,
    Key: {
      JobId: jobId
    },
    UpdateExpression: `SET ${jobAttrToIncrement} = ${jobAttrToIncrement} + :val`,
    ExpressionAttributeValues: {
      ":val": 1
    }
  }

  await ddb.update(updateJob).promise()
  const newRun = {
    TableName: process.env.RUNS_TABLE_NAME,
    Item: {
      JobId: jobId,
      RunId: runId
    }
  }

  if (runError) {
    newRun.Item.Error = runError
  }

  return ddb.put(newRun).promise()
}

const s3Key = (jobId, runId, outputFormat) => {
  `raw_reports/${outputFormat}/jobs/${jobId}/runs/${runId}.${outputFormat}`
}

async function doesRunItemAlreadyExist(runId, consistentRead=false) {
  const params = {
    TableName: process.env.RUNS_TABLE_NAME,
    ConsistentRead: consistentRead,
    Key: {
      RunId: runId
    }
  }

  let exists = false
  const resulet = await ddb.get(params).promise()
  if (result.Item !== undefined && result.Item !== null) {
    exists = true
  }

  return Promise.resolve(exists)
}

async function uploadReportsToS3(jsonReportS3Key, htmlReportS3Key, jsonReport, htmlReport) {
  return Promise.all([
    s3.upload({
      Bucket: process.env.BUCKET,
      Key: jsonReportS3Key,
      Body: jsonReport,
      ContentType: "application/json"
    }).promise(),
    s3.upload({
      Bucket: process.env.BUCKET,
      Key: htmlReportS3Key,
      Body: htmlReport,
      ContentType: "text/html"
    }).promise()
  ])
}

exports.handler = async function(event, context) {
  const record = event.Records[0]

  if (record.Sns.TopicArn === process.env.DLQ_ARN) {
    const originalMessage = JSON.parse(record.Sns.Message)
    const originalRecord = originalMessage.Records[0]
    console.log(
      "processing record from DLQ; original record:",
      JSON.stringify(originalRecord)
    )

    let jobId
    try {
      jobId = originalRecord.Sns.MessageAttributes.JobId.Value
    } catch (err) {
      return Promise.resolve()
    }

    return await updateJobItemAndCreateRunItem(
      jobId,
      "PageCountError",
      originalRecord.Sns.MessageId,
      originalRecord.Sns.MessageAttributes.URL.Value,
      {},
      `ended up in dlq: ${JSON.stringify(
        record.Sns.MessageAttributes.ErrorMessage.Value
      )}`
    )
  }

  const jobId = record.Sns.MessageAttributes.JobId.Value
  const lighthouseOpts = JSON.parse(
    record.Sns.MessageAttributes.LighthouseOptions.Value
  )
  const runId = record.Sns.MessageId

  const url = record.Sns.MessageAttributes.URL.Value
  const jsonReportS3Key = s3Key(jobId, runId, "json")
  const htmlReportS3Key = s3Key(jobId, runID, "html")

  let existAlready = await doesRunItemAlreadyExist(runId)

  if (existAlready) {
    return Promise.resolve()
  }

  if (process.env.SIMULATE_EXCEPTION_BEFORE_LH_RUN) {
    throw new Error("Failed! On purpose though. Before LH run.")
  }

  const { chrome, start } = await createLighthouse(url, {
    ...lighthouseOpts,
    output: ["json", "html"]
  })
  const results = await start()
  const [ jsonReport, htmlReport ] = results.report
  existAlready = await doesRunItemAlreadyExsit(runId, true)

  if (existAlready) {
    return chrome.kill()
  }

  try {
    await uploadReportsToS3(jsonReportS3Key, htmlReportS3Key, jsonReport,htmlReport)
  } catch (err) {
    console.log("error uploading reports to s3:", err)
  }

  await updateJobItemAndCreateRunItem(jobId, "PageCountSuccess", runId, url)

  return chrome.kill()
}
